import { test, expect } from "@playwright/test";

test("a served application executes, rejects invalid input, unregisters, and resets on reload", async ({
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

  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("registered");

  await page.getByRole("button", { name: "Execute on page" }).click();
  await expect(page.locator("#result")).toHaveText('{"count":2}');
  await expect(page.locator("#count")).toHaveText("2");

  await page.getByLabel("Amount").fill("-1");
  await page.getByRole("button", { name: "Execute on page" }).click();
  await expect(page.locator("#result")).toHaveText("UnknownError");
  await expect(page.locator("#count")).toHaveText("2");

  await page.getByRole("button", { name: "Unregister", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("unregistered");
  const tools = await page.evaluate(() => document.modelContext!.getTools());
  expect(tools).toEqual([]);

  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("registered");
  const registered = await page.evaluate(() => document.modelContext!.getTools());
  expect(registered.map((tool) => tool.name)).toEqual(["increment"]);

  await page.getByRole("button", { name: "Unregister", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("unregistered");
  const remaining = await page.evaluate(() => document.modelContext!.getTools());
  expect(remaining).toEqual([]);

  await page.reload();
  await expect(page.locator("#status")).toHaveText("registered");
  await expect(page.locator("#count")).toHaveText("0");
  expect(errors).toEqual([]);
});
