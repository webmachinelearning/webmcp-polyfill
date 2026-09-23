import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wptRoot = process.env.WPT_ROOT;
if (!wptRoot) {
  throw new Error("Set WPT_ROOT to a WPT checkout");
}

const browser = process.env.WPT_BROWSER ?? "chrome";
const browserArguments: string[] = [];
switch (browser) {
  case "chrome": {
    const binary = process.env.CHROME_BIN;
    assert.ok(binary, "Set CHROME_BIN to Chrome Canary");
    browserArguments.push(
      "--channel=canary",
      "--binary",
      binary,
      "--install-webdriver",
      "--headless",
      "--no-enable-experimental",
      "--binary-arg=--disable-features=WebMCP",
    );
    break;
  }
  case "firefox": {
    const binary = process.env.FIREFOX_BIN;
    browserArguments.push("--headless", "--setpref=dom.origin_agent_cluster.default=true");
    browserArguments.push(
      ...(binary
        ? ["--channel=stable", "--binary", binary]
        : ["--channel=nightly", "--install-browser"]),
    );
    break;
  }
  case "safari":
    browserArguments.push("--channel=stable");
    break;
  default:
    throw new Error(`Unsupported WPT_BROWSER: ${browser}; use chrome, firefox, or safari`);
}

const pinnedRevision = readFileSync(new URL("./revision.txt", import.meta.url), "utf8").trim();
const checkoutRevision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: wptRoot,
  encoding: "utf8",
});
if (checkoutRevision.error) {
  throw checkoutRevision.error;
}
if (checkoutRevision.status !== 0 || checkoutRevision.stdout.trim() !== pinnedRevision) {
  throw new Error(
    `Check out WPT ${pinnedRevision}; review upstream changes before changing the pin`,
  );
}

const checkoutDiff = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: wptRoot });
if (checkoutDiff.error) {
  throw checkoutDiff.error;
}
if (checkoutDiff.status !== 0) {
  throw new Error("WPT has tracked changes; restore the pinned sources before running conformance");
}

const reportPath = fileURLToPath(new URL(`../wpt-results/${browser}.json`, import.meta.url));
mkdirSync(dirname(reportPath), { recursive: true });
rmSync(reportPath, { force: true });

const wptRun = spawnSync(
  process.env.WPT_PYTHON ?? "python3",
  [
    resolve(wptRoot, "wpt"),
    "--venv",
    process.env.WPT_VENV ?? resolve(wptRoot, "_venv_polyfill"),
    "run",
    ...browserArguments,
    "--yes",
    "--test-types",
    "testharness",
    "--inject-script",
    fileURLToPath(new URL("../dist/polyfill.js", import.meta.url)),
    "--manifest",
    resolve(wptRoot, "MANIFEST.json"),
    "--metadata",
    fileURLToPath(new URL("./metadata", import.meta.url)),
    "--log-mach=-",
    "--log-wptreport",
    reportPath,
    "--no-pause-after-test",
    "--processes",
    browser === "safari" ? "1" : "4",
    "--retry-unexpected=0",
    "--no-manifest-download",
    "--include",
    "/webmcp",
    ...process.argv.slice(2),
    browser,
  ],
  { cwd: wptRoot, stdio: "inherit" },
);
if (wptRun.error) {
  throw wptRun.error;
}
const reportContents = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
if (!reportContents.trim()) {
  throw new Error("WPT produced no report");
}

const { results }: WptReport = JSON.parse(reportContents);
const subtests = results.flatMap((fileResult) => fileResult.subtests);
const uniqueFiles = new Set(results.map((fileResult) => fileResult.test));

// These counts belong to the pinned revision; an incomplete run must not pass.
assert.equal(results.length, 67, "Expected all 67 WebMCP testharness files at the pin");
assert.equal(uniqueFiles.size, results.length, "WPT repeated a test file");
assert.equal(
  subtests.length,
  161,
  "WPT subtest count changed; inspect the report and expectations",
);
const statusCounts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOTRUN: 0, PRECONDITION_FAILED: 0 };
for (const { status } of subtests) {
  statusCounts[status] += 1;
}
console.log(
  `WPT (${browser}): ${results.length} files; subtests ${JSON.stringify(statusCounts)}.` +
    ` Report: ${reportPath}`,
);
if (wptRun.status !== 0) {
  throw new Error(`WPT reported unexpected results (exit ${wptRun.status})`);
}

interface WptReport {
  results: {
    test: string;
    subtests: { status: "PASS" | "FAIL" | "TIMEOUT" | "NOTRUN" | "PRECONDITION_FAILED" }[];
  }[];
}
