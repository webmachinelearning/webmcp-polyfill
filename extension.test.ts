import { test, expect, chromium } from "@playwright/test";
import { readFile, mkdir, writeFile, copyFile, open } from "node:fs/promises";
import { By } from "selenium-webdriver";
import { Driver, Options, ServiceBuilder } from "selenium-webdriver/firefox.js";

// This extension is a test fixture only. Its fixed button action is deliberately
// visible on the page; production authorization belongs in the extension's UI.
test("an installed extension discovers and executes real page tools across worlds", async ({
  browserName,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const extension = testInfo.outputPath("extension");
  await mkdir(extension, { recursive: true });
  const guide = await readFile(new URL("./EXTENSIONS.md", import.meta.url), "utf8");
  const blocks = [...guide.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const marker = "const [{ result }]";
  const isolated = "// ISOLATED world:";
  const guideIs = (n: string, what: string) => `EXTENSIONS.md's ${n} js code block ${what}`;
  expect(blocks, guideIs("set of", "must be exactly two: invocation, then notifications")).toHaveLength(2);
  const [invocation, notifications] = blocks;
  expect(invocation, guideIs("first", "must be the chrome.scripting example")).toContain(
    "chrome.scripting.executeScript",
  );
  expect(invocation, guideIs("first", `must still split at "${marker}"`)).toContain(marker);
  expect(notifications, guideIs("second", `must still contain "${isolated}"`)).toContain(isolated);
  const discovery = invocation.slice(0, invocation.indexOf(marker));
  const [main] = notifications.split(isolated);
  expect(main, "the MAIN-world half must add a toolchange listener").toContain(
    'addEventListener("toolchange"',
  );
  const firefox = browserName === "firefox";
  await Promise.all([
    copyFile(new URL("./dist/polyfill.js", import.meta.url), `${extension}/webmcp-polyfill.js`),
    writeFile(`${extension}/main.js`, main),
    writeFile(
      `${extension}/background.js`,
      `
      chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (!sender.tab || !sender.url.startsWith('http://localhost:8793/')) return;
        (async () => {
          const tabId = sender.tab.id;
          if (message.action === 'discover') {
            ${discovery}
            return { tools };
          }
          const toolName = 'increment';
          const inputObject = { amount: 2 };
          ${invocation}
          return { tools, result };
        })().then(respond, error => respond({ error: String(error) }));
        return true;
      });
    `,
    ),
    writeFile(
      `${extension}/isolated.js`,
      `
      async function refresh() {
        const response = await chrome.runtime.sendMessage({ action: 'discover' });
        document.getElementById('extension-tools').textContent = response.error ?? response.tools.map(tool => tool.name).join(',');
        document.documentElement.dataset.toolChangeWorld = typeof document.modelContext;
      }
      document.addEventListener('my-extension:webmcp-tools-changed', refresh);
      document.addEventListener('DOMContentLoaded', refresh);
      document.addEventListener('click', async event => {
        if (event.target.id !== 'extension-run') return;
        const response = await chrome.runtime.sendMessage({ action: 'execute' });
        document.getElementById('extension-result').textContent = response.error ?? response.result;
      });
    `,
    ),
    writeFile(
      `${extension}/manifest.json`,
      JSON.stringify({
        manifest_version: 3,
        name: "WebMCP test fixture",
        version: "0.0.0",
        permissions: ["scripting"],
        host_permissions: ["http://localhost/*"],
        background: firefox ? { scripts: ["background.js"] } : { service_worker: "background.js" },
        browser_specific_settings: { gecko: { id: "webmcp-test@example.org" } },
        content_scripts: [
          {
            matches: ["http://localhost/*"],
            js: ["webmcp-polyfill.js", "main.js"],
            world: "MAIN",
            run_at: "document_start",
          },
          { matches: ["http://localhost/*"], js: ["isolated.js"], run_at: "document_start" },
        ],
      }),
    ),
  ]);

  let navigate: (url: string) => Promise<void>;
  let evaluate: (script: string) => Promise<string | boolean | null>;
  let click: (id: string) => Promise<void>;
  let close: () => Promise<void>;
  if (firefox) {
    // Selenium owns the Firefox protocol, process, and session lifecycle.
    const options = new Options().addArguments("-headless");
    if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
    const log = testInfo.outputPath("geckodriver.log");
    const logFile = await open(log, "w");
    const service = new ServiceBuilder(process.env.GECKODRIVER ?? "geckodriver")
      .setStdio(["ignore", logFile.fd, logFile.fd])
      .build();
    const driver = Driver.createSession(options, service);
    close = async () => {
      try {
        await testInfo.attach("page.png", {
          body: Buffer.from(await driver.takeScreenshot(), "base64"),
          contentType: "image/png",
        });
      } finally {
        try {
          await driver.quit();
        } finally {
          await logFile.close();
          await testInfo.attach("geckodriver.log", { path: log, contentType: "text/plain" });
        }
      }
    };
    try {
      const capabilities = await driver.getCapabilities();
      await testInfo.attach("browser.json", {
        body: JSON.stringify({ version: capabilities.getBrowserVersion() }),
        contentType: "application/json",
      });
      // Use Gecko's directory endpoint so both browsers load the same unpacked fixture.
      const session = await driver.getSession();
      const install = await request.post(
        new URL(`/session/${session.getId()}/moz/addon/install`, await service.address()).href,
        {
          data: { path: extension, temporary: true },
        },
      );
      await expect(install).toBeOK();
      navigate = (url) => driver.get(url);
      evaluate = (script) => driver.executeScript(script);
      click = (id) => driver.findElement(By.id(id)).click();
    } catch (error) {
      await close();
      throw error;
    }
  } else {
    const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--disable-features=WebMCP,WebMCPTesting",
      ],
    });
    const page = await context.newPage();
    await testInfo.attach("browser.json", {
      body: JSON.stringify({ version: context.browser()?.version() }),
      contentType: "application/json",
    });
    navigate = async (url) => {
      await page.goto(url);
    };
    // Both drivers accept a script body; Playwright evaluates an expression.
    evaluate = (script) => page.evaluate(`(() => { ${script} })()`);
    click = (id) => page.locator(`#${id}`).click();
    close = () => context.close();
  }
  try {
    const content = (id: string) =>
      evaluate(`return document.getElementById('${id}')?.textContent`);
    await navigate("http://localhost:8793/extension");
    await expect.poll(() => content("status")).toBe("registered");
    await expect.poll(() => content("extension-tools")).toBe("increment");
    expect(await evaluate("return document.documentElement.dataset.toolChangeWorld")).toBe(
      "undefined",
    );
    await click("extension-run");
    await expect.poll(() => content("extension-result")).toBe('{"count":2}');
    expect(await content("count")).toBe("2");
    await click("unregister");
    await expect.poll(() => content("status")).toBe("unregistered");
    await expect.poll(() => content("extension-tools")).toBe("");
    await click("register");
    await expect.poll(() => content("extension-tools")).toBe("increment");
    await navigate("http://localhost:8793/extension?reload");
    await expect.poll(() => content("extension-tools")).toBe("increment");
    expect(await content("count")).toBe("0");
    await click("extension-run");
    await expect.poll(() => content("extension-result")).toBe('{"count":2}');
    // The fixture's permission is deliberately restricted to localhost.
    await navigate("http://127.0.0.1:8793/");
    expect(
      await evaluate("return document.title + '|' + ('modelContext' in document)"),
      "the polyfill must not be injected on an origin the extension does not match",
    ).toBe("WebMCP test|false");
  } finally {
    await close();
  }
});
