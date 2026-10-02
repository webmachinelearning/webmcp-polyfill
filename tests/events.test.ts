import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  const hasNativeContext = await page.evaluate(() => "modelContext" in document);
  expect(hasNativeContext).toBe(false);
  await page.addScriptTag({ url: "/auto.js" });
});

test("event interfaces convert their arguments like Web IDL constructors", async ({ page }) => {
  const outcome = await page.evaluate(() => {
    const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "none");
    return [ToolActivatedEvent, ToolCancelEvent].map((EventInterface) => {
      const global = Object.getOwnPropertyDescriptor(window, EventInterface.name)!;
      const toolName = Object.getOwnPropertyDescriptor(EventInterface.prototype, "toolName")!;
      const errors = [
        () => Reflect.construct(EventInterface, []),
        () => Reflect.apply(EventInterface, undefined, ["x"]),
        () => toolName.get!.call(new Event("x")),
        () => Reflect.construct(EventInterface, ["x", { toolName: Symbol("name") }]),
      ].map((operation) => {
        try {
          operation();
          return "none";
        } catch (error) {
          return nameOf(error);
        }
      });

      const reads: PropertyKey[] = [];
      const init = new Proxy(
        { toolName: 1, bubbles: true },
        {
          get(target, key, receiver) {
            reads.push(key);
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const converted: ToolActivatedEvent | ToolCancelEvent = Reflect.construct(EventInterface, [
        undefined,
        init,
      ]);
      const plain = new EventInterface("plain");

      return {
        name: EventInterface.name,
        length: EventInterface.length,
        global: [global.writable, global.enumerable, global.configurable],
        parent: Object.getPrototypeOf(EventInterface) === Event,
        getter: [typeof toolName.get, toolName.set, toolName.enumerable, toolName.configurable],
        brand: Object.prototype.toString.call(plain),
        errors,
        plain: [
          plain.type,
          plain.toolName,
          plain.bubbles,
          plain.cancelable,
          plain.composed,
          plain.isTrusted,
        ],
        converted: [converted.type, converted.toolName, converted.bubbles],
        reads,
      };
    });
  });

  expect(outcome).toEqual(
    ["ToolActivatedEvent", "ToolCancelEvent"].map((name) => ({
      name,
      length: 1,
      global: [true, false, true],
      parent: true,
      getter: ["function", undefined, true, true],
      brand: `[object ${name}]`,
      errors: ["TypeError", "TypeError", "TypeError", "TypeError"],
      plain: ["plain", "", false, false, false, false],
      converted: ["undefined", "1", true],
      reads: ["bubbles", "cancelable", "composed", "toolName"],
    })),
  );
});

test("lifecycle event handlers keep EventHandler semantics", async ({ page }) => {
  const outcome = await page.evaluate(() => {
    const context = document.modelContext!;
    return (["ontoolactivated", "ontoolcancel"] as const).map((name) => {
      const type = name.slice("on".length);
      const initial = context[name];
      const receivers: unknown[] = [];
      context[name] = function (this: unknown) {
        receivers.push(this);
        return false;
      };
      const event = new Event(type, { cancelable: true });
      context.dispatchEvent(event);
      const coerced = Reflect.set(context, name, 1) && context[name];
      context.dispatchEvent(new Event(type));
      return {
        initial,
        calls: receivers.length,
        receiver: receivers[0] === context,
        defaultPrevented: event.defaultPrevented,
        coerced,
      };
    });
  });

  expect(outcome).toEqual(
    Array(2).fill({
      initial: null,
      calls: 1,
      receiver: true,
      defaultPrevented: true,
      coerced: null,
    }),
  );
});

test("toolactivated precedes the callback and toolcancel follows its aborted signal", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const order: string[] = [];
    const events: Event[] = [];
    const { promise: cancelled, resolve: observeCancel } = Promise.withResolvers<void>();
    context.addEventListener("toolactivated", (event) => {
      events.push(event);
      order.push(event.type);
    });
    context.addEventListener("toolcancel", (event) => {
      events.push(event);
      order.push(event.type);
      observeCancel();
    });

    const { promise: started, resolve: enter } = Promise.withResolvers<void>();
    await context.registerTool({
      name: "pending",
      description: "Pending",
      execute(_input, { signal }) {
        order.push("callback");
        signal.addEventListener("abort", () => order.push("callback aborted"), { once: true });
        enter();
        return new Promise(() => {});
      },
    });

    const tool = (await context.getTools())[0]!;
    const controller = new AbortController();
    const rejected = context
      .executeTool(tool, {}, { signal: controller.signal })
      .catch(() => order.push("rejected"));
    await started;
    controller.abort();
    await Promise.all([rejected, cancelled]);

    return {
      order,
      events: events.map((event) => [
        event.constructor.name,
        event instanceof ToolActivatedEvent || event instanceof ToolCancelEvent
          ? event.toolName
          : null,
        event.target === context,
        event.bubbles,
        event.cancelable,
        event.composed,
      ]),
    };
  });

  expect(outcome).toEqual({
    order: ["toolactivated", "callback", "rejected", "callback aborted", "toolcancel"],
    events: [
      ["ToolActivatedEvent", "pending", true, false, false, false],
      ["ToolCancelEvent", "pending", true, false, false, false],
    ],
  });
});

test("no lifecycle event fires for a call that never starts or has already settled", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const events: string[] = [];
    context.ontoolactivated = (event) => events.push(`${event.type}:${event.toolName}`);
    context.ontoolcancel = (event) => events.push(`${event.type}:${event.toolName}`);
    await context.registerTool({ name: "done", description: "Done", execute: () => "done" });
    const done = (await context.getTools())[0]!;
    const missing = { ...done, name: "missing" };

    // Aborted before the dispatch task.
    const early = new AbortController();
    const skipped = context.executeTool(done, {}, { signal: early.signal }).catch(() => null);
    early.abort();
    await skipped;

    // Rejected before invocation.
    await context.executeTool(missing, {}).catch(() => null);

    // Aborted after the callback settled.
    const late = new AbortController();
    await context.executeTool(done, {}, { signal: late.signal });
    late.abort();

    // The cancellation task was queued before this discovery resolves.
    await context.getTools();
    return events;
  });

  expect(outcome).toEqual(["toolactivated:done"]);
});
