import { test, expect } from "@playwright/test";

// The realm members that installation would define or replace.
const readRealmMembers = () => [
  Object.getOwnPropertyDescriptor(SubmitEvent.prototype, "agentInvoked")?.get,
  Object.getOwnPropertyDescriptor(SubmitEvent.prototype, "respondWith")?.value,
  HTMLFormElement.prototype.submit,
  Reflect.get(window, "ModelContext"),
  Reflect.get(window, "ToolActivatedEvent"),
  Reflect.get(window, "ToolCancelEvent"),
];

test("loading the polyfill preserves the real native context and registered tools", async ({
  page,
  browser,
}, testInfo) => {
  await page.goto("/");
  const registerToolType = await page.evaluate(() => typeof document.modelContext?.registerTool);
  expect(registerToolType).toBe("function");

  const original = await page.evaluateHandle(async () => {
    const context = document.modelContext!;
    const getter = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get;
    await context.registerTool({
      name: "native",
      description: "Native tool",
      execute: () => ({ native: true }),
    });
    return { context, getter };
  });
  const originalMembers = await page.evaluateHandle(readRealmMembers);

  await page.addScriptTag({ url: "/auto.js" });

  const outcome = await page.evaluate(async ({ context, getter }) => {
    const currentGetter = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get;
    const tools = await document.modelContext!.getTools();
    return {
      sameContext: document.modelContext === context,
      sameGetter: currentGetter === getter,
      tools: tools.map((tool) => tool.name),
    };
  }, original);
  expect(outcome).toEqual({ sameContext: true, sameGetter: true, tools: ["native"] });
  const currentMembers = await page.evaluateHandle(readRealmMembers);
  const membersUnchanged = await originalMembers.evaluate(
    (before, after) => before.every((member, index) => member === after[index]),
    currentMembers,
  );
  expect(membersUnchanged).toBe(true);

  await testInfo.attach("browser.json", {
    body: JSON.stringify({ version: browser.version() }),
    contentType: "application/json",
  });
});
