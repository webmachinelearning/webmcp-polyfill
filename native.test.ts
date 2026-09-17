import { test, expect } from "@playwright/test";

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

  await testInfo.attach("browser.json", {
    body: JSON.stringify({ version: browser.version() }),
    contentType: "application/json",
  });
});
