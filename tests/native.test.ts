import { test, expect } from "@playwright/test";

// The realm members that installation would define or replace.
const realmMembers = () =>
  [
    Object.getOwnPropertyDescriptor(SubmitEvent.prototype, "agentInvoked")?.get,
    Object.getOwnPropertyDescriptor(SubmitEvent.prototype, "respondWith")?.value,
    HTMLFormElement.prototype.submit,
    Reflect.get(window, "ModelContext"),
    Reflect.get(window, "ToolActivatedEvent"),
    Reflect.get(window, "ToolCancelEvent"),
  ].map(String);

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
  const members = await page.evaluate(realmMembers);

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
  expect(await page.evaluate(realmMembers)).toEqual(members);

  await testInfo.attach("browser.json", {
    body: JSON.stringify({ version: browser.version() }),
    contentType: "application/json",
  });
});
