import { test, expect } from "@playwright/test";

test("a served application registers, discovers, unregisters, and resets on reload", async ({
  page,
  browser,
}, testInfo) => {
  await testInfo.attach("browser.json", {
    body: JSON.stringify({ project: testInfo.project.name, version: browser.version() }),
    contentType: "application/json",
  });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/app");
  await expect(page.locator("#status")).toHaveText("registered");
  expect(
    await page.evaluate(async () =>
      (await document.modelContext!.getTools()).map((tool) => tool.name),
    ),
  ).toEqual(["increment"]);
  await page.getByRole("button", { name: "Unregister", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("unregistered");
  expect(await page.evaluate(() => document.modelContext!.getTools())).toEqual([]);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("registered");
  await expect(page.locator("#count")).toHaveText("0");
  expect(errors).toEqual([]);
});
