import { test, expect } from "@playwright/test";

test("loading the polyfill preserves the real native context and registered tools", async ({
  page,
  browser,
}, testInfo) => {
  await page.goto("/");
  expect(await page.evaluate(() => typeof document.modelContext?.registerTool)).toBe("function");
  const original = await page.evaluateHandle(async () => {
    const context = document.modelContext;
    const getter = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get;
    await document.modelContext!.registerTool({
      name: "native",
      description: "Native tool",
      execute: () => ({ native: true }),
    });
    return { context, getter };
  });
  await page.addScriptTag({ url: "/auto.js" });
  expect(
    await page.evaluate(
      async ({ context, getter }) => ({
        sameContext: document.modelContext === context,
        sameGetter:
          Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get === getter,
        tools: (await document.modelContext!.getTools()).map((tool) => tool.name),
      }),
      original,
    ),
  ).toEqual({ sameContext: true, sameGetter: true, tools: ["native"] });
  await testInfo.attach("browser.json", {
    body: JSON.stringify({ version: browser.version() }),
    contentType: "application/json",
  });
});
