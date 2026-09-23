import { test, expect, type Frame } from "@playwright/test";

const localOrigin = "http://localhost:8793";
const remoteOrigin = "http://127.0.0.1:8793";

async function addFrame(
  parent: Frame,
  name: string,
  options: { origin?: string; allow?: string; path?: string } = {},
): Promise<Frame> {
  const { origin = localOrigin, allow = "tools *", path = "/frame" } = options;
  await parent.evaluate(
    async (settings) => {
      const iframe = document.createElement("iframe");
      iframe.name = settings.name;
      iframe.src = `${settings.origin}${settings.path}?name=${encodeURIComponent(settings.name)}`;
      iframe.allow = settings.allow;
      await new Promise<void>((resolve) => {
        iframe.onload = () => resolve();
        document.body.append(iframe);
      });
    },
    { name, origin, allow, path },
  );

  const child = parent.childFrames().find((frame) => frame.name() === name);
  if (!child) {
    throw new Error(`Frame ${name} did not load`);
  }
  return child;
}

function discover(frame: Frame): Promise<string[]> {
  return frame.evaluate(async () =>
    (await document.modelContext!.getTools()).map((tool) => tool.name),
  );
}

function sendToolRequests(settings: { origin: string; name: string }): Promise<unknown[]> {
  const requests = [{ kind: "getTools" }, { kind: "execute", name: settings.name, input: "{}" }];
  return Promise.all(
    requests.map(async (request) => {
      const channel = new MessageChannel();
      const response = new Promise<unknown>((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data);
      });
      top!.postMessage(`webmcp-polyfill:connect:${crypto.randomUUID()}`, settings.origin, [
        channel.port2,
      ]);
      // This frame's polyfill consumes the ready message, so the request waits on the port.
      channel.port1.postMessage(request);
      const reply = await response;
      channel.port1.close();
      return reply;
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => "modelContext" in document)).toBe(false);
  await page.goto("/frame");
});

test("discovers the full same-origin frame tree without merging duplicate names", async ({
  page,
}) => {
  const left = await addFrame(page.mainFrame(), "left");
  const right = await addFrame(page.mainFrame(), "right");
  const nested = await addFrame(left, "nested");

  for (const [frame, toolName] of [
    [page.mainFrame(), "top"],
    [left, "shared"],
    [right, "shared"],
    [nested, "nested"],
  ] as const) {
    await frame.evaluate(async (name) => {
      await document.modelContext!.registerTool({
        name,
        description: name,
        execute: () => window.name || "top",
      });
    }, toolName);
  }

  const discovered = await nested.evaluate(async () => {
    const context = document.modelContext!;
    const tools = await context.getTools();
    return Promise.all(
      tools.map(async (tool) => ({
        name: tool.name,
        owner: tool.window.name || "top",
        result: await context.executeTool(tool, {}),
      })),
    );
  });

  expect(discovered).toEqual([
    { name: "nested", owner: "nested", result: '"nested"' },
    { name: "shared", owner: "left", result: '"left"' },
    { name: "shared", owner: "right", result: '"right"' },
    { name: "top", owner: "top", result: '"top"' },
  ]);
});

test("cross-origin discovery requires exposure and an explicit origin filter", async ({ page }) => {
  const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
  await page.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "local",
      description: "Local",
      execute: () => null,
    });
  });
  await owner.evaluate(async (origin) => {
    const context = document.modelContext!;
    document.body.dataset.privateExecutions = "0";
    await context.registerTool({
      name: "private",
      description: "Private",
      execute() {
        document.body.dataset.privateExecutions = "1";
        return "private";
      },
    });
    await context.registerTool(
      {
        name: "public",
        description: "Public",
        execute: () => "public",
      },
      { exposedTo: [origin] },
    );
  }, localOrigin);

  const result = await page.evaluate(async (origin) => {
    const context = document.modelContext!;
    const defaults = await context.getTools();
    const filtered = await context.getTools({ fromOrigins: [origin] });
    const remote = filtered.find((tool) => tool.name === "public")!;
    const rejected = [];
    for (const forged of [
      { ...remote, name: "private" },
      { ...remote, origin: location.origin },
    ]) {
      rejected.push(
        await context.executeTool(forged, {}).then(
          () => "resolved",
          (error: Error) => error.name,
        ),
      );
    }
    return {
      defaults: defaults.map((tool) => tool.name),
      filtered: filtered.map((tool) => tool.name),
      ownerWindow: remote.window === frames[0],
      remoteResult: await context.executeTool(remote, {}),
      rejected,
    };
  }, remoteOrigin);

  expect(result).toEqual({
    defaults: ["local"],
    filtered: ["local", "public"],
    ownerWindow: true,
    remoteResult: '"public"',
    rejected: ["UnknownError", "UnknownError"],
  });
  await expect(owner.locator("body")).toHaveAttribute("data-private-executions", "0");
});

test("cross-origin frames require tools delegation before using the API", async ({ page }) => {
  const denied = await addFrame(page.mainFrame(), "denied", { origin: remoteOrigin, allow: "" });
  const result = await denied.evaluate(async () => {
    const context = document.modelContext!;
    return Promise.all(
      [
        context.registerTool({ name: "denied", description: "Denied", execute: () => null }),
        context.getTools(),
        context.executeTool({
          name: "denied",
          title: "",
          description: "Denied",
          window,
          origin: location.origin,
        }),
      ].map((pending) =>
        pending.then(
          () => "resolved",
          (error: Error) => error.name,
        ),
      ),
    );
  });

  expect(result).toEqual(["NotAllowedError", "NotAllowedError", "NotAllowedError"]);
});

test("raw messages cannot bypass a caller frame's tools policy", async ({ page }) => {
  const denied = await addFrame(page.mainFrame(), "denied", { origin: remoteOrigin, allow: "" });
  await page.evaluate(async (origin) => {
    document.body.dataset.executions = "0";
    await document.modelContext!.registerTool(
      {
        name: "exposed",
        description: "Exposed",
        execute() {
          document.body.dataset.executions = "1";
          return "private result";
        },
      },
      { exposedTo: [origin] },
    );
  }, remoteOrigin);

  const replies = await denied.evaluate(sendToolRequests, { origin: localOrigin, name: "exposed" });

  expect(replies).toEqual([{ kind: "error" }, { kind: "error" }]);
  await expect(page.locator("body")).toHaveAttribute("data-executions", "0");
});

test("internal frame messages preserve ordinary one-shot page listeners", async ({ page }) => {
  const child = await addFrame(page.mainFrame(), "child", { origin: remoteOrigin });
  await page.evaluate(() => {
    window.addEventListener(
      "message",
      (event: MessageEvent<string>) => {
        document.body.dataset.message = event.data;
      },
      { once: true },
    );
  });
  await child.evaluate(async (origin) => {
    window.addEventListener(
      "message",
      (event: MessageEvent<string>) => {
        document.body.dataset.message = event.data;
      },
      { once: true },
    );
    await document.modelContext!.getTools({ fromOrigins: [origin] });
    parent.postMessage("application-message", origin);
  }, localOrigin);

  await expect(page.locator("body")).toHaveAttribute("data-message", "application-message");

  // The caller consumed a ready message; its one-shot listener must still be waiting.
  await page.evaluate((origin) => frames[0]!.postMessage("caller-message", origin), remoteOrigin);
  await expect(child.locator("body")).toHaveAttribute("data-message", "caller-message");
});

test("an intermediate frame cannot forge permissions denied by an ancestor", async ({ page }) => {
  const denied = await addFrame(page.mainFrame(), "denied", { origin: remoteOrigin, allow: "" });
  await denied.goto(`${remoteOrigin}/?name=malicious`);
  await denied.evaluate(() => {
    document.body.dataset.forgedPermissions = "0";
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const requester = event.source;
      if (!requester || !("window" in requester) || typeof event.data !== "string") {
        return;
      }
      // Only frames that announce themselves are consulted.
      if (event.data === "webmcp-polyfill:announce") {
        requester.postMessage("webmcp-polyfill:present", event.origin);
        return;
      }
      if (!event.data.startsWith("webmcp-polyfill:connect:")) {
        return;
      }
      const id = event.data.slice("webmcp-polyfill:connect:".length);
      const port = event.ports[0];
      if (!port) {
        return;
      }
      port.onmessage = (message) => {
        if (message.data.kind === "permission") {
          document.body.dataset.forgedPermissions = String(
            Number(document.body.dataset.forgedPermissions) + 1,
          );
          port.postMessage({ kind: "result", value: true });
        } else {
          port.postMessage({ kind: "error" });
        }
        port.close();
      };
      requester.postMessage(`webmcp-polyfill:ready:${id}`, event.origin);
    });
  });
  const child = await addFrame(denied, "child");
  await page.evaluate(async () => {
    document.body.dataset.executions = "0";
    await document.modelContext!.registerTool({
      name: "exposed",
      description: "Exposed",
      execute() {
        document.body.dataset.executions = "1";
        return "private result";
      },
    });
  });

  const failures = await child.evaluate(async () => {
    const context = document.modelContext!;
    return Promise.all(
      [
        context.registerTool({ name: "denied", description: "Denied", execute: () => null }),
        context.getTools(),
      ].map((pending) =>
        pending.then(
          () => "resolved",
          (error: Error) => error.name,
        ),
      ),
    );
  });
  expect(failures).toEqual(["NotAllowedError", "NotAllowedError"]);
  expect(await child.evaluate(sendToolRequests, { origin: localOrigin, name: "exposed" })).toEqual([
    { kind: "error" },
    { kind: "error" },
  ]);
  expect(
    Number(await denied.locator("body").getAttribute("data-forged-permissions")),
  ).toBeGreaterThan(0);
  await expect(page.locator("body")).toHaveAttribute("data-executions", "0");
});

test("routes between cross-origin siblings and through nested frames", async ({ page }) => {
  const branch = await addFrame(page.mainFrame(), "branch", { origin: remoteOrigin });
  const owner = await addFrame(branch, "owner");
  const caller = await addFrame(page.mainFrame(), "caller", { origin: remoteOrigin });
  await owner.evaluate(async (origin) => {
    await document.modelContext!.registerTool(
      {
        name: "nested",
        description: "Nested tool",
        execute: () => "nested result",
      },
      { exposedTo: [origin] },
    );
  }, remoteOrigin);

  const result = await caller.evaluate(async (origin) => {
    const context = document.modelContext!;
    const tool = (await context.getTools({ fromOrigins: [origin] }))[0]!;
    return {
      name: tool.name,
      ownerWindow: tool.window === top!.frames[0]!.frames[0],
      result: await context.executeTool(tool, {}),
    };
  }, localOrigin);

  expect(result).toEqual({ name: "nested", ownerWindow: true, result: '"nested result"' });
});

for (const [owningDocument, origin] of [
  ["the caller's own document", localOrigin],
  ["a cross-origin frame", remoteOrigin],
] as const) {
  test(`omitted execution input produces a fresh empty object in ${owningDocument}`, async ({
    page,
  }) => {
    const owner =
      origin === localOrigin
        ? page.mainFrame()
        : await addFrame(page.mainFrame(), "owner", { origin });
    await owner.evaluate(async (callerOrigin) => {
      const inputs = new Set<object>();
      await document.modelContext!.registerTool(
        {
          name: "empty",
          description: "Inspect default input",
          execute(input) {
            const result = {
              empty: Object.keys(input).length === 0,
              fresh: !inputs.has(input),
              ownerRealm: Object.getPrototypeOf(input) === Object.prototype,
            };
            inputs.add(input);
            Object.assign(input, { changed: true });
            return result;
          },
        },
        { exposedTo: [callerOrigin] },
      );
    }, localOrigin);

    const results = await page.evaluate(async (ownerOrigin) => {
      const context = document.modelContext!;
      const tool = (await context.getTools({ fromOrigins: [ownerOrigin] }))[0]!;
      const omitted = await context.executeTool(tool);
      const explicitUndefined = await context.executeTool(tool, undefined, {
        signal: new AbortController().signal,
      });
      return [JSON.parse(omitted), JSON.parse(explicitUndefined)];
    }, origin);

    expect(results).toEqual([
      { empty: true, fresh: true, ownerRealm: true },
      { empty: true, fresh: true, ownerRealm: true },
    ]);
  });
}

test("remote execution copies JSON input and supplies a signal from the owner's realm", async ({
  page,
}) => {
  const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
  const callbackSignals = await owner.evaluateHandle(async (origin) => {
    "use strict";
    const signals: AbortSignal[] = [];
    await document.modelContext!.registerTool(
      {
        name: "echo",
        description: "Echo",
        execute(input, { signal }) {
          signals.push(signal);
          return {
            input,
            signal: signal instanceof AbortSignal && !signal.aborted,
            unbound: this === undefined,
          };
        },
      },
      { exposedTo: [origin] },
    );
    return signals;
  }, localOrigin);

  const result = await page.evaluate(async (origin) => {
    const context = document.modelContext!;
    const tool = (await context.getTools({ fromOrigins: [origin] }))[0]!;
    const input = { nested: { value: 1 } };
    const controller = new AbortController();
    const pending = context.executeTool(tool, input, { signal: controller.signal });
    input.nested.value = 9;
    return { result: await pending, callerAborted: controller.signal.aborted };
  }, remoteOrigin);

  expect(result).toEqual({
    result: '{"input":{"nested":{"value":1}},"signal":true,"unbound":true}',
    callerAborted: false,
  });
  expect(
    await callbackSignals.evaluate((signals) => signals.map((signal) => signal.aborted)),
  ).toEqual([false]);
});

test("remote cancellation preserves the caller's reason and ignores late serialization", async ({
  page,
}) => {
  const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
  await owner.evaluate(async (origin) => {
    await document.modelContext!.registerTool(
      {
        name: "pending",
        description: "Pending",
        execute(_input, { signal }) {
          document.body.dataset.state = "started";
          signal.addEventListener(
            "abort",
            () => {
              document.body.dataset.state = "aborted";
              document.body.dataset.reason = signal.reason.name;
            },
            { once: true },
          );
          return new Promise((resolve) => {
            document.addEventListener(
              "finish",
              () =>
                resolve({
                  toJSON() {
                    document.body.dataset.serialized = "true";
                    return "late";
                  },
                }),
              { once: true },
            );
          });
        },
      },
      { exposedTo: [origin] },
    );
  }, localOrigin);

  const execution = await page.evaluateHandle(async (origin) => {
    const context = document.modelContext!;
    const tool = (await context.getTools({ fromOrigins: [origin] }))[0]!;
    const controller = new AbortController();
    const reason = { cancelled: true, nonCloneable: () => null };
    const result = context.executeTool(tool, {}, { signal: controller.signal }).then(
      () => false,
      (error) => error === reason,
    );
    return { controller, reason, result };
  }, remoteOrigin);

  await expect(owner.locator("body")).toHaveAttribute("data-state", "started");
  await execution.evaluate(({ controller, reason }) => controller.abort(reason));
  expect(await execution.evaluate(async ({ result }) => result)).toBe(true);
  await expect(owner.locator("body")).toHaveAttribute("data-state", "aborted");
  await expect(owner.locator("body")).toHaveAttribute("data-reason", "AbortError");
  await owner.evaluate(async () => {
    document.dispatchEvent(new Event("finish"));
    await document.modelContext!.getTools();
  });
  expect(await owner.locator("body").getAttribute("data-serialized")).toBeNull();
});

test("same-document navigation preserves a remote invocation and its callback signal", async ({
  page,
}) => {
  const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
  await owner.evaluate(async (origin) => {
    await document.modelContext!.registerTool(
      {
        name: "pending",
        description: "Pending",
        execute(_input, { signal }) {
          document.body.dataset.state = "started";
          return new Promise((resolve) => {
            document.addEventListener(
              "finish",
              () => {
                resolve({ aborted: signal.aborted });
              },
              { once: true },
            );
          });
        },
      },
      { exposedTo: [origin] },
    );
  }, localOrigin);
  const execution = await page.evaluateHandle(async (origin) => {
    const context = document.modelContext!;
    const tool = (await context.getTools({ fromOrigins: [origin] }))[0]!;
    return { result: context.executeTool(tool, {}) };
  }, remoteOrigin);
  await expect(owner.locator("body")).toHaveAttribute("data-state", "started");

  await page.goto("/frame#caller");
  await owner.goto(`${owner.url()}#owner`);
  await owner.evaluate(() => document.dispatchEvent(new Event("finish")));

  expect(await execution.evaluate(async ({ result }) => result)).toBe('{"aborted":false}');
});

test("propagates registration changes only to frames allowed to discover the tool", async ({
  page,
}) => {
  const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
  const observed = await page.evaluateHandle((origin) => {
    const context = document.modelContext!;
    const snapshots: string[][] = [];
    context.addEventListener("toolchange", async () => {
      const tools = await context.getTools({ fromOrigins: [origin] });
      snapshots.push(tools.map((tool) => tool.name));
    });
    return snapshots;
  }, remoteOrigin);
  const registration = await owner.evaluateHandle(async (origin) => {
    const controller = new AbortController();
    await document.modelContext!.registerTool({
      name: "private",
      description: "Private",
      execute: () => null,
    });
    await document.modelContext!.registerTool(
      {
        name: "visible",
        description: "Visible",
        execute: () => null,
      },
      { exposedTo: [origin], signal: controller.signal },
    );
    return controller;
  }, localOrigin);

  await expect.poll(() => observed.evaluate((snapshots) => snapshots)).toEqual([["visible"]]);
  await registration.evaluate((controller) => controller.abort());
  await expect.poll(() => observed.evaluate((snapshots) => snapshots)).toEqual([["visible"], []]);
});

test("child registration dispatches parent then child events before its promise resolves", async ({
  page,
}) => {
  await addFrame(page.mainFrame(), "owner");
  const order = await page.evaluate(async () => {
    const events: string[] = [];
    const child = frames[0]!.document.modelContext!;
    document.modelContext!.addEventListener("toolchange", () => events.push("parent"));
    child.addEventListener("toolchange", () => events.push("child"));
    await child.registerTool({
      name: "ordered",
      description: "Ordered",
      execute: () => null,
    });
    events.push("registered");
    return events;
  });

  expect(order).toEqual(["parent", "child", "registered"]);
});

test("registration waits for a slow cross-origin toolchange listener", async ({ page }) => {
  const observer = await addFrame(page.mainFrame(), "observer", { origin: remoteOrigin });
  const listener = await observer.evaluateHandle(() => {
    const completion = { finishedAt: 0 };
    document.modelContext!.addEventListener(
      "toolchange",
      () => {
        const start = performance.now();
        while (performance.now() - start < 1100) {
          // A synchronous author listener can outlast the frame protocol's control deadline.
        }
        completion.finishedAt = Date.now();
      },
      { once: true },
    );
    return completion;
  });

  const registeredAt = await page.evaluate(async (origin) => {
    await document.modelContext!.registerTool(
      { name: "slow-listener", description: "Slow listener", execute: () => null },
      { exposedTo: [origin] },
    );
    return Date.now();
  }, remoteOrigin);
  const finishedAt = await listener.evaluate((completion) => completion.finishedAt);

  expect(finishedAt).toBeGreaterThan(0);
  expect(registeredAt).toBeGreaterThanOrEqual(finishedAt);
});

for (const change of ["navigate", "remove"] as const) {
  test(`rejects a running invocation when its owner frame is ${change}d`, async ({ page }) => {
    const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
    await owner.evaluate(async (origin) => {
      await document.modelContext!.registerTool(
        {
          name: "pending",
          description: "Pending",
          execute() {
            document.body.dataset.state = "started";
            return new Promise(() => {});
          },
        },
        { exposedTo: [origin] },
      );
    }, localOrigin);
    const execution = await page.evaluateHandle(async (origin) => {
      const context = document.modelContext!;
      const tool = (await context.getTools({ fromOrigins: [origin] }))[0]!;
      const result = context.executeTool(tool, {}).then(
        () => "resolved",
        (error: Error) => error.name,
      );
      return { result };
    }, remoteOrigin);
    await expect(owner.locator("body")).toHaveAttribute("data-state", "started");

    if (change === "navigate") {
      await owner.goto(`${remoteOrigin}/frame?replacement`);
    } else {
      await page.locator('iframe[name="owner"]').evaluate((iframe) => iframe.remove());
    }

    expect(await execution.evaluate(async ({ result }) => result)).toBe("UnknownError");
    const tools = await page.evaluate(async (origin) => {
      return (await document.modelContext!.getTools({ fromOrigins: [origin] })).map(
        (tool) => tool.name,
      );
    }, remoteOrigin);
    expect(tools).toEqual([]);
  });

  test(`aborts the callback when its caller frame is ${change}d`, async ({ page }) => {
    const caller = await addFrame(page.mainFrame(), "caller", { origin: remoteOrigin });
    await page.evaluate(async (origin) => {
      await document.modelContext!.registerTool(
        {
          name: "pending",
          description: "Pending",
          execute(_input, { signal }) {
            document.body.dataset.state = "started";
            return new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  document.body.dataset.state = "aborted";
                  document.body.dataset.reason = signal.reason.name;
                  resolve("cancelled");
                },
                { once: true },
              );
            });
          },
        },
        { exposedTo: [origin] },
      );
    }, remoteOrigin);
    await caller.evaluate(async (origin) => {
      const context = document.modelContext!;
      const tool = (await context.getTools({ fromOrigins: [origin] }))[0]!;
      void context.executeTool(tool, {}).catch(() => {});
    }, localOrigin);
    await expect(page.locator("body")).toHaveAttribute("data-state", "started");

    if (change === "navigate") {
      await caller.goto(`${remoteOrigin}/frame?replacement`);
    } else {
      await page.locator('iframe[name="caller"]').evaluate((iframe) => iframe.remove());
    }

    await expect(page.locator("body")).toHaveAttribute("data-state", "aborted");
    await expect(page.locator("body")).toHaveAttribute("data-reason", "AbortError");
  });
}

test("excludes another frame tree even when a same-origin window supplies its descriptor", async ({
  page,
}) => {
  const opened = page.waitForEvent("popup");
  const otherWindow = await page.evaluateHandle(() => window.open("/frame"));
  const popup = await opened;
  await popup.waitForLoadState();
  await popup.evaluate(async () => {
    document.body.dataset.executions = "0";
    await document.modelContext!.registerTool({
      name: "separate",
      description: "Separate window",
      execute() {
        document.body.dataset.executions = "1";
        return "separate";
      },
    });
  });

  const result = await otherWindow.evaluate(async (other) => {
    const context = document.modelContext!;
    const tools = await context.getTools();
    const tool = (await other!.document.modelContext!.getTools())[0]!;
    return {
      discovered: tools.length,
      execution: await context.executeTool(tool, {}).then(
        () => "resolved",
        (error: Error) => error.name,
      ),
    };
  });
  expect(result).toEqual({ discovered: 0, execution: "UnknownError" });
  await expect(popup.locator("body")).toHaveAttribute("data-executions", "0");
  await popup.close();
});

test("frames without the polyfill delay neither registration nor discovery", async ({ page }) => {
  await addFrame(page.mainFrame(), "silent-one", { path: "/" });
  await addFrame(page.mainFrame(), "silent-two", { origin: remoteOrigin, path: "/" });
  await addFrame(page.mainFrame(), "silent-three", { origin: remoteOrigin, path: "/" });

  const timings = await page.evaluate(async () => {
    const context = document.modelContext!;
    const registrationStart = performance.now();
    await context.registerTool({ name: "top", description: "Top", execute: () => "top" });
    const registration = performance.now() - registrationStart;
    const discoveryStart = performance.now();
    const tools = await context.getTools();
    return {
      registration,
      discovery: performance.now() - discoveryStart,
      names: tools.map((tool) => tool.name),
    };
  });

  expect(timings.names).toEqual(["top"]);
  expect(timings.registration).toBeLessThan(250);
  expect(timings.discovery).toBeLessThan(250);
});

test("a frame that registers at startup notifies and discovers its parent", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const context = document.modelContext!;
    await context.registerTool({ name: "top", description: "Top", execute: () => "top" });
    document.body.dataset.changes = "0";
    context.addEventListener("toolchange", () => {
      document.body.dataset.changes = String(Number(document.body.dataset.changes) + 1);
    });
  });

  const startup = await addFrame(page.mainFrame(), "startup", { path: "/startup" });

  await expect(startup.locator("html")).toHaveAttribute("data-tools", "startup,top");
  await expect(page.locator("body")).toHaveAttribute("data-changes", "1");
});

test("discovery in a frame's first task finds its parent's tools", async ({ page }) => {
  await page.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "top",
      description: "Top",
      execute: () => "top",
    });
  });

  const startup = await addFrame(page.mainFrame(), "startup", { path: "/startup-discovery" });

  await expect(startup.locator("html")).toHaveAttribute("data-tools", "top");
});

test("a navigated frame replaces its tools and rediscovers its peers", async ({ page }) => {
  const child = await addFrame(page.mainFrame(), "child");
  await page.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "top",
      description: "Top",
      execute: () => "top",
    });
  });
  await child.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "first",
      description: "First",
      execute: () => "first",
    });
  });

  await child.goto(`${localOrigin}/frame?replacement`);
  await child.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "second",
      description: "Second",
      execute: () => "second",
    });
  });

  expect(await discover(page.mainFrame())).toEqual(["second", "top"]);
  expect(await discover(child)).toEqual(["second", "top"]);
});

test("a window that navigates away from the polyfill stops costing a deadline", async ({
  page,
}) => {
  const child = await addFrame(page.mainFrame(), "child");
  await page.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "top",
      description: "Top",
      execute: () => "top",
    });
  });
  await child.goto(`${localOrigin}/?replacement`);

  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const firstStart = performance.now();
    await context.getTools();
    const first = performance.now() - firstStart;
    const secondStart = performance.now();
    const tools = await context.getTools();
    return {
      first,
      second: performance.now() - secondStart,
      names: tools.map((tool) => tool.name),
    };
  });

  expect(outcome.names).toEqual(["top"]);
  expect(outcome.first).toBeGreaterThan(400);
  expect(outcome.second).toBeLessThan(250);
});

test("a same-origin frame in a closed shadow root registers and meets a later sibling", async ({
  page,
}) => {
  await page.evaluate(async (origin) => {
    const host = document.createElement("div");
    document.body.append(host);
    const iframe = document.createElement("iframe");
    iframe.name = "shadow";
    iframe.src = `${origin}/frame?name=shadow`;
    iframe.allow = "tools *";
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      host.attachShadow({ mode: "closed" }).append(iframe);
    });
  }, localOrigin);

  const shadow = page.frames().find((frame) => frame.name() === "shadow");
  if (!shadow) {
    throw new Error("The shadow frame did not load");
  }
  await shadow.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "shadow",
      description: "Shadow",
      execute: () => "shadow",
    });
  });

  const sibling = await addFrame(page.mainFrame(), "sibling");
  await sibling.evaluate(async () => {
    await document.modelContext!.registerTool({
      name: "sibling",
      description: "Sibling",
      execute: () => "sibling",
    });
  });

  await expect.poll(() => discover(sibling)).toEqual(["shadow", "sibling"]);
  await expect.poll(() => discover(shadow)).toEqual(["shadow", "sibling"]);
});

test("cross-origin discovery preserves tool metadata and its owner window", async ({ page }) => {
  const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
  await owner.evaluate(async (origin) => {
    await document.modelContext!.registerTool(
      {
        name: "described",
        title: "Described",
        description: "Described tool",
        annotations: { debugging: true, readOnlyHint: true },
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        execute: () => null,
      },
      { exposedTo: [origin] },
    );
  }, localOrigin);

  const discovered = await page.evaluate(async (origin) => {
    const tool = (await document.modelContext!.getTools({ fromOrigins: [origin] }))[0]!;
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      origin: tool.origin,
      ownerWindow: tool.window === frames[0],
    };
  }, remoteOrigin);

  expect(discovered).toEqual({
    name: "described",
    title: "Described",
    description: "Described tool",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    annotations: {
      consequentialHint: false,
      debugging: true,
      readOnlyHint: true,
      untrustedContentHint: false,
    },
    origin: remoteOrigin,
    ownerWindow: true,
  });
});

const delegationCases = [
  { origin: remoteOrigin, allow: "", outcome: "NotAllowedError" },
  { origin: remoteOrigin, allow: "tools", outcome: "resolved" },
  { origin: remoteOrigin, allow: "tools 'none'", outcome: "NotAllowedError" },
  { origin: remoteOrigin, allow: "tools 'self'", outcome: "NotAllowedError" },
  { origin: remoteOrigin, allow: `tools ${remoteOrigin}`, outcome: "resolved" },
  { origin: remoteOrigin, allow: "tools *", outcome: "resolved" },
  { origin: localOrigin, allow: "", outcome: "resolved" },
  { origin: localOrigin, allow: "tools 'self'", outcome: "resolved" },
  { origin: localOrigin, allow: "tools 'none'", outcome: "NotAllowedError" },
];

test("iframe allow attributes delegate tools to the origins they name", async ({ page }) => {
  const outcomes: string[] = [];
  for (const [index, settings] of delegationCases.entries()) {
    const child = await addFrame(page.mainFrame(), `child-${index}`, settings);
    outcomes.push(
      await child.evaluate(() =>
        document.modelContext!.getTools().then(
          () => "resolved",
          (error: Error) => error.name,
        ),
      ),
    );
  }

  expect(outcomes).toEqual(delegationCases.map((settings) => settings.outcome));
});

test("a blank frame keeps the delegation its allow attribute names", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    iframe.src = "about:blank";
    iframe.allow = "tools";
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      document.body.append(iframe);
    });
    const blank = iframe.contentDocument!;
    const script = blank.createElement("script");
    script.src = `${location.origin}/auto.js`;
    await new Promise<void>((resolve) => {
      script.onload = () => resolve();
      blank.head.append(script);
    });
    return blank.modelContext!.getTools().then(
      () => "resolved",
      (error: Error) => error.name,
    );
  });

  expect(outcome).toBe("resolved");
});

test("a refresh request is honored only from the top frame", async ({ page }) => {
  const observer = await addFrame(page.mainFrame(), "observer", { path: "/" });
  await addFrame(page.mainFrame(), "victim");
  const announced = await observer.evaluate(async () => {
    const victim = parent.frames[1]!;
    const answered = Promise.withResolvers<void>();
    document.body.dataset.announces = "0";
    window.addEventListener("message", (event: MessageEvent<string>) => {
      if (event.source !== victim) {
        return;
      }
      if (event.data === "webmcp-polyfill:announce") {
        document.body.dataset.announces = String(Number(document.body.dataset.announces) + 1);
      } else if (event.data === "webmcp-polyfill:present") {
        answered.resolve();
      }
    });

    victim.postMessage("webmcp-polyfill:refresh", "*");
    // The announcement the victim answers is queued after the refresh it must ignore.
    victim.postMessage("webmcp-polyfill:announce", "*");
    await answered.promise;
    return document.body.dataset.announces;
  });

  expect(announced).toBe("0");
  await page.evaluate(() => frames[1]!.postMessage("webmcp-polyfill:refresh", "*"));
  await expect(observer.locator("body")).toHaveAttribute("data-announces", "1");
});

test("a peer that accepts a connection and never answers discovery cannot stall discovery", async ({
  page,
}) => {
  const hostile = await addFrame(page.mainFrame(), "hostile", { path: "/" });
  await hostile.evaluate(async () => {
    const learned = Promise.withResolvers<void>();
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const requester = event.source;
      if (!requester || !("window" in requester) || typeof event.data !== "string") {
        return;
      }
      if (event.data === "webmcp-polyfill:announce") {
        requester.postMessage("webmcp-polyfill:present", event.origin);
      } else if (event.data === "webmcp-polyfill:present") {
        learned.resolve();
      } else if (event.data.startsWith("webmcp-polyfill:connect:")) {
        const id = event.data.slice("webmcp-polyfill:connect:".length);
        const port = event.ports[0]!;
        port.onmessage = (message) => {
          if (message.data.kind === "changed") {
            port.postMessage({ kind: "result" });
          }
        };
        requester.postMessage(`webmcp-polyfill:ready:${id}`, event.origin);
      }
    });
    parent.postMessage("webmcp-polyfill:announce", "*");
    await learned.promise;
  });

  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") {
      warnings.push(message.text());
    }
  });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const registrationStart = performance.now();
    await context.registerTool({ name: "top", description: "Top", execute: () => "top" });
    const registration = performance.now() - registrationStart;
    const discoveryStart = performance.now();
    const tools = await context.getTools();
    return {
      registration,
      discovery: performance.now() - discoveryStart,
      names: tools.map((tool) => tool.name),
    };
  });

  expect(outcome.names).toEqual(["top"]);
  expect(outcome.registration).toBeLessThan(2000);
  expect(outcome.discovery).toBeLessThan(2000);
  expect(warnings).toEqual([]);
});

test("a peer's malformed discovery replies are discarded and reported", async ({ page }) => {
  const hostile = await addFrame(page.mainFrame(), "hostile", { path: "/" });
  const replyCount = await hostile.evaluate(async () => {
    const tool = { name: "fake", title: "", description: "Fake" };
    const replies: unknown[] = [
      null,
      [{ name: "fake" }],
      [{ ...tool, annotations: 42 }],
      [{ ...tool, annotations: { readOnlyHint: "yes" } }],
      [{ ...tool, serializedSchema: "{" }],
    ];
    let discovery = 0;
    const learned = Promise.withResolvers<void>();
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const requester = event.source;
      if (!requester || !("window" in requester) || typeof event.data !== "string") {
        return;
      }
      if (event.data === "webmcp-polyfill:announce") {
        requester.postMessage("webmcp-polyfill:present", event.origin);
      } else if (event.data === "webmcp-polyfill:present") {
        learned.resolve();
      } else if (event.data.startsWith("webmcp-polyfill:connect:")) {
        const id = event.data.slice("webmcp-polyfill:connect:".length);
        const port = event.ports[0]!;
        port.onmessage = (message) => {
          const value = message.data.kind === "getTools" ? replies[discovery++] : 42;
          port.postMessage({ kind: "result", value });
        };
        requester.postMessage(`webmcp-polyfill:ready:${id}`, event.origin);
      }
    });
    parent.postMessage("webmcp-polyfill:announce", "*");
    await learned.promise;
    return replies.length;
  });

  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") {
      warnings.push(message.text());
    }
  });
  const outcome = await page.evaluate(async (count) => {
    const context = document.modelContext!;
    await context.registerTool({ name: "top", description: "Top", execute: () => "top" });
    const discoveries: string[][] = [];
    for (let index = 0; index < count; index++) {
      discoveries.push((await context.getTools()).map((tool) => tool.name));
    }
    const fake = {
      name: "fake",
      title: "",
      description: "Fake",
      origin: location.origin,
      window: frames[0]!,
    };
    return {
      discoveries,
      execution: await context.executeTool(fake, {}).then(
        () => "resolved",
        (error: Error) => error.name,
      ),
    };
  }, replyCount);

  expect(outcome).toEqual({
    discoveries: Array.from({ length: replyCount }, () => ["top"]),
    execution: "UnknownError",
  });
  expect(warnings).toEqual(
    Array.from({ length: replyCount }, () =>
      expect.stringContaining("WebMCP: could not read tools from a frame."),
    ),
  );
});

test("a connection that never sends its request is answered with an error", async ({ page }) => {
  const child = await addFrame(page.mainFrame(), "child");
  const reply = await child.evaluate(
    (origin) =>
      new Promise<unknown>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => resolve(event.data);
        top!.postMessage(`webmcp-polyfill:connect:${crypto.randomUUID()}`, origin, [
          channel.port2,
        ]);
      }),
    localOrigin,
  );

  expect(reply).toEqual({ kind: "error" });
});

test("an error that overtakes the ready message rejects the call", async ({ page }) => {
  const peer = await addFrame(page.mainFrame(), "peer", { path: "/" });
  await peer.evaluate(() => {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const requester = event.source;
      if (
        !requester ||
        !("window" in requester) ||
        typeof event.data !== "string" ||
        !event.data.startsWith("webmcp-polyfill:connect:")
      ) {
        return;
      }
      const id = event.data.slice("webmcp-polyfill:connect:".length);
      event.ports[0]?.postMessage({ kind: "error" });
      setTimeout(() => requester.postMessage(`webmcp-polyfill:ready:${id}`, event.origin), 100);
    });
  });

  const outcome = await page.evaluate(() =>
    document
      .modelContext!.executeTool(
        {
          name: "gone",
          title: "",
          description: "Gone",
          origin: location.origin,
          window: frames[0]!,
        },
        {},
      )
      .then(
        () => "resolved",
        (error: Error) => error.name,
      ),
  );

  expect(outcome).toBe("UnknownError");
});

test("cross-origin requests cause no blocked-frame errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  const owner = await addFrame(page.mainFrame(), "owner", { origin: remoteOrigin });
  await owner.evaluate(async (origin) => {
    await document.modelContext!.registerTool(
      { name: "remote", description: "Remote", execute: () => "remote" },
      { exposedTo: [origin] },
    );
  }, localOrigin);

  const result = await page.evaluate(async (origin) => {
    const context = document.modelContext!;
    const tool = (await context.getTools({ fromOrigins: [origin] }))[0]!;
    return context.executeTool(tool, {});
  }, remoteOrigin);

  expect(result).toBe('"remote"');
  expect(errors).toEqual([]);
});
