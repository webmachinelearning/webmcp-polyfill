import { test, expect } from "@playwright/test";
import type {} from "./index.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => "modelContext" in document)).toBe(false);
});

test("every operation rejects when the server opts out of origin-keyed agent clustering", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8793/no-cluster");
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const errors = [];
      for (const operation of [
        () => context.getTools(),
        () => context.registerTool({ name: "x", description: "X", execute: () => null }),
        () =>
          context.executeTool(
            { name: "x", title: "", description: "X", window, origin: location.origin },
            {},
          ),
      ]) {
        try {
          await operation();
          errors.push("resolved");
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          errors.push(error.name);
        }
      }
      return errors;
    }),
  ).toEqual(["SecurityError", "SecurityError", "SecurityError"]);
});

test("only potentially trustworthy origins reach the cross-document refusal", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  // NotSupportedError means the origin was accepted as potentially trustworthy and then refused
  // because cross-document exposure needs native WebMCP; SecurityError means it was rejected.
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const results: [string, string][] = [];
      for (const origin of [
        "https://example.test",
        "blob:https://example.test/id",
        "blob:http://localhost:8793/id",
        "wss://example.test",
        "file:///tmp",
        "http://127.0.0.1:8793",
        "http://[::1]:8793",
        "http://localhost:8793",
        "http://localhost.:8793",
        "http://app.localhost:8793",
        "ws://localhost:8793",
        "http://example.test",
        "blob:http://example.test/id",
        "ws://example.test",
        "ftp://localhost",
        "http://127.example.test",
        "not a url",
      ]) {
        try {
          await context.getTools({ fromOrigins: [origin] });
          results.push([origin, "resolved"]);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          results.push([origin, error.name]);
        }
      }
      return results;
    }),
  ).toEqual([
    ["https://example.test", "NotSupportedError"],
    ["blob:https://example.test/id", "NotSupportedError"],
    ["blob:http://localhost:8793/id", "NotSupportedError"],
    ["wss://example.test", "NotSupportedError"],
    ["file:///tmp", "NotSupportedError"],
    ["http://127.0.0.1:8793", "NotSupportedError"],
    ["http://[::1]:8793", "NotSupportedError"],
    ["http://localhost:8793", "NotSupportedError"],
    ["http://localhost.:8793", "NotSupportedError"],
    ["http://app.localhost:8793", "NotSupportedError"],
    ["ws://localhost:8793", "NotSupportedError"],
    ["http://example.test", "SecurityError"],
    ["blob:http://example.test/id", "SecurityError"],
    ["ws://example.test", "SecurityError"],
    ["ftp://localhost", "SecurityError"],
    ["http://127.example.test", "SecurityError"],
    ["not a url", "SecurityError"],
  ]);
});

test("a cross-origin frame is denied without a native Permissions Policy", async ({ page }) => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const iframe = document.createElement("iframe");
        iframe.src = "http://127.0.0.1:8793/";
        iframe.onload = () => resolve();
        document.body.append(iframe);
      }),
  );
  const frame = page.frames().find((candidate) => candidate.url() === "http://127.0.0.1:8793/");
  expect(frame, "the cross-origin child frame must be attached").toBeTruthy();
  await frame!.addScriptTag({ url: "http://127.0.0.1:8793/auto.js" });
  expect(
    await frame!.evaluate(async () => {
      try {
        await document.modelContext!.getTools();
        return "resolved";
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return error.name;
      }
    }),
  ).toBe("NotAllowedError");
});

test("a signal option that is not an AbortSignal is rejected", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const results: [string, string][] = [];
      const tool = { name: "x", description: "X", execute: () => null };
      for (const signal of [1, {}, null, "abort"]) {
        const label = JSON.stringify(signal)!;
        try {
          // @ts-expect-error Exercise invalid JavaScript callers at the Web IDL boundary.
          await context.registerTool(tool, { signal });
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

test("an already-aborted registration signal registers nothing and fires no toolchange", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      let changes = 0;
      context.ontoolchange = () => changes++;
      let reason: unknown = "resolved";
      try {
        await context.registerTool(
          { name: "x", description: "X", execute: () => null },
          { signal: AbortSignal.abort("already aborted") },
        );
      } catch (error) {
        reason = error;
      }
      // getTools() resolves from a queued task, so awaiting it drains any pending toolchange.
      return { reason, count: (await context.getTools()).length, changes };
    }),
  ).toEqual({ reason: "already aborted", count: 0, changes: 0 });
});

test("registration converts every dictionary member in Web IDL order", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const reads: string[] = [];
      const record = <T>(name: string, value: T): T => {
        reads.push(name);
        return value;
      };
      await document.modelContext!.registerTool(
        {
          get annotations() {
            return record("annotations", undefined);
          },
          get description() {
            return record("description", "D");
          },
          get execute() {
            return record("execute", () => null);
          },
          get inputSchema() {
            return record("inputSchema", undefined);
          },
          get name() {
            return record("name", "ordered");
          },
          get title() {
            return record("title", "Ordered");
          },
        },
        {
          get exposedTo() {
            return record("exposedTo", undefined);
          },
          get signal() {
            return record("signal", undefined);
          },
        },
      );
      return reads;
    }),
  ).toEqual([
    "annotations",
    "description",
    "execute",
    "inputSchema",
    "name",
    "title",
    "exposedTo",
    "signal",
  ]);
});

test("origin conversion gets an iterator only once and preserves its receiver", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      let reads = 0;
      let receiver = false;
      const origins = {
        get [Symbol.iterator]() {
          if (++reads > 1) throw new Error("Iterator getter was read twice");
          return function (this: typeof origins) {
            receiver = this === origins;
            return [][Symbol.iterator]();
          };
        },
      };
      // @ts-expect-error Web IDL accepts iterables; the published types use arrays.
      await document.modelContext!.getTools({ fromOrigins: origins });
      return { reads, receiver };
    }),
  ).toEqual({ reads: 1, receiver: true });
});

test("operations on a real detached frame reject in the frame's realm", async ({ page }) => {
  // The /app iframe installs the polyfill; this document deliberately does not.
  const frame = await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    iframe.src = "/app";
    const loaded = new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
    });
    document.body.append(iframe);
    await loaded;
    const context = iframe.contentDocument!.modelContext!;
    const tool = (await context.getTools())[0];
    const FrameException = iframe.contentDocument!.defaultView!.DOMException;
    iframe.remove();
    const errors = [];
    for (const operation of [
      () => context.getTools(),
      () =>
        context.registerTool({ name: "detached", description: "Detached", execute: () => null }),
      () => context.executeTool(tool, {}),
    ]) {
      try {
        await operation();
        errors.push("resolved");
      } catch (error) {
        errors.push(error instanceof FrameException ? error.name : "wrong realm");
      }
    }
    return errors;
  });
  expect(frame).toEqual(["InvalidStateError", "InvalidStateError", "InvalidStateError"]);
});

test("installs once, exposes only standard members, and keeps document identity", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const initial = await page.evaluateHandle(() => document.modelContext);
  const result = await page.evaluate(() => {
    const context = document.modelContext!;
    const constructor = "ModelContext" in window ? window.ModelContext : undefined;
    if (typeof constructor !== "function") throw new Error("ModelContext constructor is missing");
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!;
    let constructionError = "";
    try {
      Reflect.construct(constructor, []);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      constructionError = error.name;
    }
    const getterErrors = [];
    for (const receiver of [{}, Object.create(Document.prototype), null, undefined, 1]) {
      try {
        descriptor.get!.call(receiver);
        getterErrors.push("resolved");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        getterErrors.push(error.name);
      }
    }
    return {
      same: context === document.modelContext,
      members: Object.keys(Object.getPrototypeOf(context)).sort(),
      own: Object.keys(context),
      brand: Object.prototype.toString.call(context),
      instance: context instanceof constructor && context instanceof EventTarget,
      constructorParent: Object.getPrototypeOf(constructor) === EventTarget,
      constructorName: constructor.name,
      writable: descriptor.set !== undefined,
      alias: "modelContext" in navigator,
      testing: "modelContextTesting" in navigator,
      lengths: [context.registerTool.length, context.getTools.length, context.executeTool.length],
      constructionError,
      getterErrors,
    };
  });
  expect(result).toEqual({
    same: true,
    members: ["executeTool", "getTools", "ontoolchange", "registerTool"],
    own: [],
    brand: "[object ModelContext]",
    instance: true,
    constructorParent: true,
    constructorName: "ModelContext",
    writable: false,
    alias: false,
    testing: false,
    lengths: [1, 0, 1],
    constructionError: "TypeError",
    getterErrors: ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError"],
  });
  const getter = await page.evaluateHandle(
    () => Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get,
  );
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(
      ([previous, previousGetter]) => ({
        context: document.modelContext === previous,
        getter:
          Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get ===
          previousGetter,
      }),
      [initial, getter] as const,
    ),
  ).toEqual({ context: true, getter: true });
});

test("snapshots registration metadata and returns sorted, independent copies", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    const context = document.modelContext!;
    const schema = { type: "object", properties: { query: { type: "string" } } };
    const annotations = { consequentialHint: true };
    await context.registerTool({
      name: "z",
      description: "Z",
      inputSchema: schema,
      annotations,
      execute: () => null,
    });
    await context.registerTool({ name: "a", description: "A", execute: () => null });
    schema.properties.query.type = "number";
    annotations.consequentialHint = false;
    const tools = await context.getTools();
    const firstSchema = JSON.stringify(tools[1].inputSchema);
    Object.assign(tools[1].inputSchema!, { mutated: true });
    tools[1].annotations!.consequentialHint = false;
    const again = await context.getTools();
    return {
      names: tools.map((tool) => tool.name),
      firstSchema,
      nextSchema: JSON.stringify(again[1].inputSchema),
      annotations: again[1].annotations,
      noSchema: Object.hasOwn(again[0], "inputSchema"),
      noAnnotations: Object.hasOwn(again[0], "annotations"),
      origin: again[0].origin,
      window: again[0].window === window,
    };
  });
  expect(result.names).toEqual(["a", "z"]);
  expect(result.firstSchema).toBe(result.nextSchema);
  expect(JSON.parse(result.nextSchema!)).toEqual({
    type: "object",
    properties: { query: { type: "string" } },
  });
  expect(result.annotations).toEqual({
    consequentialHint: true,
    readOnlyHint: false,
    untrustedContentHint: false,
  });
  expect(result).toMatchObject({
    noSchema: false,
    noAnnotations: false,
    origin: "http://localhost:8793",
    window: true,
  });
});

test("rejects invalid descriptors, duplicates and unserializable schemas", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const { rejections, registered } = await page.evaluate(async () => {
    const context = document.modelContext!;
    const good = { name: "valid", description: "Valid", execute: () => null };
    await context.registerTool(good);
    const circular = {};
    Object.assign(circular, { self: circular });
    const cases: [string, unknown][] = [
      ["null descriptor", null],
      ["execute is not callable", { ...good, execute: 1 }],
      ["name is a Symbol", { ...good, name: Symbol() }],
      ["name is already registered", good],
      ["name is empty", { ...good, name: "" }],
      ["name has a disallowed character", { ...good, name: "invalid name" }],
      ["name exceeds 128 characters", { ...good, name: "a".repeat(129) }],
      ["description is empty", { ...good, description: "" }],
      ["inputSchema is not an object", { ...good, name: "bad-schema", inputSchema: null }],
      ["inputSchema is circular", { ...good, name: "circular", inputSchema: circular }],
      [
        "inputSchema serializes to undefined",
        { ...good, name: "undefined", inputSchema: { toJSON: () => undefined } },
      ],
    ];
    const results: [string, string][] = [];
    for (const [label, descriptor] of cases) {
      try {
        // @ts-expect-error Exercise invalid JavaScript callers at the Web IDL boundary.
        await context.registerTool(descriptor);
        results.push([label, "resolved"]);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        results.push([label, error.name]);
      }
    }
    return { rejections: results, registered: (await context.getTools()).map((tool) => tool.name) };
  });
  expect(rejections).toEqual([
    ["null descriptor", "TypeError"],
    ["execute is not callable", "TypeError"],
    ["name is a Symbol", "TypeError"],
    ["name is already registered", "InvalidStateError"],
    ["name is empty", "InvalidStateError"],
    ["name has a disallowed character", "InvalidStateError"],
    ["name exceeds 128 characters", "InvalidStateError"],
    ["description is empty", "InvalidStateError"],
    ["inputSchema is not an object", "TypeError"],
    ["inputSchema is circular", "TypeError"],
    ["inputSchema serializes to undefined", "TypeError"],
  ]);
  // A rejected registration must not leave a tool behind.
  expect(registered).toEqual(["valid"]);
});

test("uses dictionary coercion without retaining or binding the tool object", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    "use strict";
    const context = document.modelContext!;
    const descriptor = {
      name: 123,
      title: "\ud800",
      description: true,
      annotations: { readOnlyHint: 1 },
      execute() {
        return this === undefined;
      },
    };
    // @ts-expect-error Web IDL coerces the deliberately non-string fields.
    await context.registerTool(descriptor);
    const [tool] = await context.getTools();
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      result: await context.executeTool(tool, {}),
    };
  });
  expect(result).toEqual({
    name: "123",
    title: "\ufffd",
    description: "true",
    annotations: { consequentialHint: false, readOnlyHint: true, untrustedContentHint: false },
    result: "true",
  });
});

test("queues toolchange and resolves registration after notification; abort unregisters", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    const context = document.modelContext!;
    const registration = new AbortController();
    const events: string[] = [];
    context.ontoolchange = () => events.push("change");
    const pending = context.registerTool(
      { name: "x", description: "X", execute: () => null },
      { signal: registration.signal },
    );
    events.push("sync");
    await Promise.resolve();
    events.push("microtask");
    await pending;
    events.push("registered");
    registration.abort();
    const tools = await context.getTools();
    return { events, count: tools.length };
  });
  expect(result).toEqual({
    events: ["sync", "microtask", "change", "registered", "change"],
    count: 0,
  });
});

test("preserves event-handler listener order when the handler is replaced", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const order: string[] = [];
      context.addEventListener("toolchange", () => order.push("first"));
      context.ontoolchange = () => order.push("old");
      context.addEventListener("toolchange", () => order.push("last"));
      context.ontoolchange = function () {
        order.push(this === context ? "new" : "wrong-this");
      };
      await context.registerTool({ name: "x", description: "X", execute: () => null });
      // Clearing the handler removes its listener, so setting one again appends at the end.
      context.ontoolchange = null;
      context.ontoolchange = () => order.push("reassigned");
      await context.registerTool({ name: "y", description: "Y", execute: () => null });
      return order;
    }),
  ).toEqual(["first", "new", "last", "first", "last", "reassigned"]);
});

test("rejects aborted registration and permits reusing its name", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const descriptor = { name: "x", description: "X", execute: () => null };
      const controller = new AbortController();
      controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
      const pending = context
        .registerTool(descriptor, { signal: controller.signal })
        .catch((error) => error);
      controller.abort("cancel-registration");
      const reason = await pending;
      await context.registerTool(descriptor);
      return [reason, (await context.getTools()).length];
    }),
  ).toEqual(["cancel-registration", 1]);
});

test("validates origins and refuses cross-document exposure", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const context = document.modelContext!;
      const errors = [];
      for (const origin of ["invalid", "http://untrusted.test", "https://other.test"]) {
        try {
          await context.getTools({ fromOrigins: [origin] });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          errors.push(error.name);
        }
      }
      try {
        await context.registerTool(
          { name: "x", description: "X", execute() {} },
          { exposedTo: ["https://other.test"] },
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        errors.push(error.name);
      }
      return errors;
    }),
  ).toEqual(["SecurityError", "SecurityError", "NotSupportedError", "NotSupportedError"]);
});

test("inactive documents get their own context but cannot register tools", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(async () => {
      const inactive = document.implementation.createHTMLDocument();
      const context = inactive.modelContext!;
      let errorName = "";
      try {
        await context.registerTool({ name: "x", description: "X", execute() {} });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        errorName = error.name;
      }
      return {
        same: context === inactive.modelContext,
        distinct: context !== document.modelContext,
        errorName,
      };
    }),
  ).toEqual({ same: true, distinct: true, errorName: "InvalidStateError" });
});

test("a detached frame rejects even when its exception constructor was never read", async ({
  page,
}) => {
  // The /app iframe installs the polyfill; this document deliberately does not.
  const result = await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    iframe.src = "/app";
    const loaded = new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
    });
    document.body.append(iframe);
    await loaded;
    const context = iframe.contentDocument!.modelContext!;
    iframe.remove();
    try {
      await context.getTools();
      return "resolved";
    } catch (error) {
      if (!error || typeof error !== "object" || !("name" in error)) throw error;
      return { name: error.name, type: Object.prototype.toString.call(error) };
    }
  });
  expect(result).toEqual({ name: "InvalidStateError", type: "[object DOMException]" });
});
