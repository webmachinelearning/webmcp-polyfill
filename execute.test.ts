import { test, expect } from "@playwright/test";
import "./index.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => "modelContext" in document)).toBe(false);
});

test("ignores late results after cancellation, including serialization side effects", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const { promise: started, resolve: entered } = Promise.withResolvers<void>();
      const { promise: completion, resolve: finish } = Promise.withResolvers<object>();
      let serialized = false;
      await context.registerTool({
        name: "late",
        description: "Late",
        execute() {
          entered();
          return completion;
        },
      });
      const [tool] = await context.getTools();
      const caller = new AbortController();
      const result = context
        .executeTool(tool, {}, { signal: caller.signal })
        .catch((error) => error);
      await started;
      caller.abort("cancelled");
      await result;
      finish({
        toJSON() {
          serialized = true;
          return {};
        },
      });
      await context.getTools();
      return serialized;
    }),
  ).toBe(false);
});

test("concurrent calls to the same tool have independent cancellation", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const signals: AbortSignal[] = [];
      const { promise: bothStarted, resolve: start } = Promise.withResolvers<void>();
      let finish!: (value: object) => void;
      await context.registerTool({
        name: "concurrent",
        description: "Concurrent",
        execute(_, { signal }) {
          signals.push(signal);
          if (signals.length === 2) start();
          return new Promise<object>((resolve) => {
            finish = resolve;
          });
        },
      });
      const [tool] = await context.getTools();
      const caller = new AbortController();
      const first = context
        .executeTool(tool, {}, { signal: caller.signal })
        .catch((error) => error);
      const second = context.executeTool(tool, {});
      await bothStarted;
      const aborted = new Promise<void>((resolve) =>
        signals[0].addEventListener("abort", () => resolve(), { once: true }),
      );
      caller.abort("first only");
      await aborted;
      finish({ second: true });
      return {
        first: await first,
        second: await second,
        aborted: signals.map((signal) => signal.aborted),
      };
    }),
  ).toEqual({ first: "first only", second: '{"second":true}', aborted: [true, false] });
});

test("executes copied object and array inputs with a fresh callback signal", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      "use strict";
      const context = document.modelContext!;
      const input = { nested: { value: 1 } };
      const caller = new AbortController();
      await context.registerTool({
        name: "echo",
        description: "Echo",
        execute(args, { signal }) {
          return {
            args,
            fresh: signal instanceof AbortSignal && signal !== caller.signal,
            unbound: this === undefined,
          };
        },
      });
      const [tool] = await context.getTools();
      const pending = context.executeTool(tool, input, { signal: caller.signal });
      input.nested.value = 9;
      return [JSON.parse(await pending), JSON.parse(await context.executeTool(tool, [1, 2]))];
    }),
  ).toEqual([
    { args: { nested: { value: 1 } }, fresh: true, unbound: true },
    { args: [1, 2], fresh: true, unbound: true },
  ]);
});

test("rejects legacy JSON strings and preserves input serialization errors", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      await context.registerTool({ name: "x", description: "X", execute: () => null });
      const [tool] = await context.getTools();
      const errors = [];
      for (const input of [
        "{}",
        null,
        undefined,
        1,
        {
          toJSON() {
            throw new RangeError("input");
          },
        },
      ]) {
        try {
          // @ts-expect-error Exercise primitive inputs from JavaScript callers.
          await context.executeTool(tool, input);
          errors.push("resolved");
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          errors.push(error.name);
        }
      }
      return errors;
    }),
  ).toEqual(["TypeError", "TypeError", "TypeError", "TypeError", "RangeError"]);
});

test("serializes results as JSON and rejects callback or serialization failures", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.addScriptTag({ url: "/auto.js" });
  const results = await page.evaluate(async () => {
    const context = document.modelContext!;
    const circular = {};
    Object.assign(circular, { self: circular });
    await context.registerTool({
      name: "x",
      description: "X",
      execute({ value }) {
        if (value === "throw") throw new Error("callback");
        if (value === "circular") return circular;
        if (value === "undefined") return undefined;
        return value;
      },
    });
    const [tool] = await context.getTools();
    const output = [];
    for (const value of ["hello", null, 42, { success: true }, "throw", "circular", "undefined"]) {
      try {
        output.push(await context.executeTool(tool, { value }));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        output.push(error.name);
      }
    }
    return output;
  });
  expect(results).toEqual([
    '"hello"',
    "null",
    "42",
    '{"success":true}',
    "UnknownError",
    "UnknownError",
    "UnknownError",
  ]);
  expect(pageErrors).toEqual([]);
});

test("cancels the caller immediately and sends a default AbortError to the callback", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const { promise: started, resolve: entered } = Promise.withResolvers<void>();
      const { promise: callbackAborted, resolve: observed } = Promise.withResolvers<string>();
      await context.registerTool({
        name: "pending",
        description: "Pending",
        execute(_input, { signal }) {
          entered();
          return new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                observed(signal.reason.name);
                resolve("late result");
              },
              { once: true },
            ),
          );
        },
      });
      const [tool] = await context.getTools();
      const controller = new AbortController();
      controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
      const result = context
        .executeTool(tool, {}, { signal: controller.signal })
        .catch((error) => error);
      await started;
      controller.abort("caller reason");
      return [await result, await callbackAborted];
    }),
  ).toEqual(["caller reason", "AbortError"]);
});

test("unregistration leaves an already-running invocation alive", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const registration = new AbortController();
      const { promise: started, resolve: entered } = Promise.withResolvers<void>();
      const { promise: completion, resolve: complete } = Promise.withResolvers<string>();
      let callbackSignal!: AbortSignal;
      await context.registerTool(
        {
          name: "pending",
          description: "Pending",
          execute(_input, { signal }) {
            callbackSignal = signal;
            entered();
            return completion;
          },
        },
        { signal: registration.signal },
      );
      const [tool] = await context.getTools();
      const pending = context.executeTool(tool, {});
      await started;
      registration.abort();
      const count = (await context.getTools()).length;
      complete("finished");
      return { count, aborted: callbackSignal.aborted, result: await pending };
    }),
  ).toEqual({ count: 0, aborted: false, result: '"finished"' });
});

// Polyfill scheduling limitation; see TESTING.md.
test("aborting before the dispatch task rejects without starting the callback", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      let executions = 0;
      await context.registerTool({
        name: "x",
        description: "X",
        execute() {
          executions++;
        },
      });
      const [tool] = await context.getTools();
      const controller = new AbortController();
      const pending = context
        .executeTool(tool, {}, { signal: controller.signal })
        .catch((error) => error);
      controller.abort("before dispatch");
      const reason = await pending;
      await context.getTools();
      return [executions, reason];
    }),
  ).toEqual([0, "before dispatch"]);
});

test("execution converts every descriptor member before invoking the tool", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    const context = document.modelContext!;
    let calls = 0;
    await context.registerTool({
      name: "descriptor",
      description: "Descriptor conversion",
      execute() {
        return ++calls;
      },
    });
    const [tool] = await context.getTools();
    const errors = [];
    const fakeWindow = {};
    Object.assign(fakeWindow, { window: fakeWindow });
    const invalid: unknown[] = [
      { ...tool, title: Symbol() },
      { ...tool, inputSchema: 1 },
      { ...tool, annotations: 1 },
      { ...tool, window: fakeWindow },
      { ...tool, window: null },
    ];
    for (const descriptor of invalid) {
      try {
        // @ts-expect-error Exercise invalid JavaScript descriptor members.
        await context.executeTool(descriptor, {});
        errors.push("resolved");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        errors.push(error.name);
      }
    }
    const invalidCalls = calls;
    const reads: string[] = [];
    const descriptor = {
      get annotations() {
        reads.push("annotations");
        return {
          get consequentialHint() {
            reads.push("consequentialHint");
            return false;
          },
          get readOnlyHint() {
            reads.push("readOnlyHint");
            return false;
          },
          get untrustedContentHint() {
            reads.push("untrustedContentHint");
            return false;
          },
        };
      },
      get description() {
        reads.push("description");
        return tool.description;
      },
      get inputSchema() {
        reads.push("inputSchema");
        return {};
      },
      get name() {
        reads.push("name");
        return tool.name;
      },
      get origin() {
        reads.push("origin");
        return tool.origin;
      },
      get title() {
        reads.push("title");
        return "Descriptor";
      },
      get window() {
        reads.push("window");
        return tool.window;
      },
    };
    await context.executeTool(descriptor, {});
    return { errors, invalidCalls, reads, calls };
  });
  expect(result).toEqual({
    errors: ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError"],
    invalidCalls: 0,
    reads: [
      "annotations",
      "consequentialHint",
      "readOnlyHint",
      "untrustedContentHint",
      "description",
      "inputSchema",
      "name",
      "origin",
      "title",
      "window",
    ],
    calls: 1,
  });
});

test("a tool belonging to another window cannot be executed", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      await context.registerTool({ name: "local", description: "Local", execute: () => null });
      const [tool] = await context.getTools();
      const iframe = document.createElement("iframe");
      iframe.src = "/app";
      await new Promise<void>((resolve) => {
        iframe.onload = () => resolve();
        document.body.append(iframe);
      });
      try {
        await context.executeTool({ ...tool, window: iframe.contentWindow! }, {});
        return "resolved";
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return error.name;
      }
    }),
  ).toBe("UnknownError");
});

test("descriptor origins are parsed, and a mismatch fails like a missing tool", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      await context.registerTool({ name: "x", description: "X", execute: () => null });
      const [tool] = await context.getTools();
      const results: [string, string][] = [];
      for (const [label, origin] of [
        ["unparseable", "not a url"],
        ["opaque", "data:,x"],
        ["another origin", "https://other.test"],
      ]) {
        try {
          await context.executeTool({ ...tool, origin }, {});
          results.push([label, "resolved"]);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          results.push([label, error.name]);
        }
      }
      return results;
    }),
  ).toEqual([
    ["unparseable", "NotSupportedError"],
    ["opaque", "NotSupportedError"],
    ["another origin", "UnknownError"],
  ]);
});

test("a signal option that is not an AbortSignal is rejected", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      await context.registerTool({ name: "x", description: "X", execute: () => null });
      const [tool] = await context.getTools();
      const results: [string, string][] = [];
      for (const signal of [1, {}, null, "abort"] as unknown[]) {
        const label = JSON.stringify(signal)!;
        try {
          // @ts-expect-error Exercise invalid JavaScript callers at the Web IDL boundary.
          await context.executeTool(tool, {}, { signal });
          results.push([label, "resolved"]);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          results.push([label, error.name]);
        }
      }
      return results;
    }),
  ).toEqual([
    ["1", "TypeError"],
    ["{}", "TypeError"],
    ["null", "TypeError"],
    ['"abort"', "TypeError"],
  ]);
});

test("unregistering before dispatch rejects without running the callback", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const registration = new AbortController();
      let executions = 0;
      await context.registerTool(
        { name: "x", description: "X", execute: () => ++executions },
        { signal: registration.signal },
      );
      const [tool] = await context.getTools();
      const pending = context.executeTool(tool, {}).catch((error: Error) => error.name);
      registration.abort();
      return [await pending, executions];
    }),
  ).toEqual(["UnknownError", 0]);
});

test("input that serializes to a non-object rejects before the callback runs", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      let executions = 0;
      await context.registerTool({
        name: "x",
        description: "X",
        execute: () => ++executions,
      });
      const [tool] = await context.getTools();
      const name = await context.executeTool(tool, { toJSON: () => 5 }).then(
        () => "resolved",
        (error: Error) => error.name,
      );
      return [name, executions];
    }),
  ).toEqual(["UnknownError", 0]);
});
