import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wptRoot = process.env.WPT_ROOT;
const chromeBinary = process.env.CHROME_BIN;
if (!wptRoot || !chromeBinary) {
  throw new Error("Set WPT_ROOT to a WPT checkout and CHROME_BIN to Chrome Canary");
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

const reportPath = fileURLToPath(new URL("../wpt-results/report.json", import.meta.url));
mkdirSync(dirname(reportPath), { recursive: true });
rmSync(reportPath, { force: true });

const wptRun = spawnSync(
  process.env.WPT_PYTHON ?? "python3",
  [
    resolve(wptRoot, "wpt"),
    "--venv",
    process.env.WPT_VENV ?? resolve(wptRoot, "_venv_polyfill"),
    "run",
    "--channel",
    "canary",
    "--binary",
    chromeBinary,
    "--yes",
    "--install-webdriver",
    "--headless",
    "--no-enable-experimental",
    "--test-types",
    "testharness",
    "--binary-arg=--disable-features=WebMCP",
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
    "4",
    "--no-manifest-download",
    "--include",
    "/webmcp",
    "chrome",
  ],
  { cwd: wptRoot, stdio: "inherit" },
);
if (wptRun.error) {
  throw wptRun.error;
}
if (!existsSync(reportPath)) {
  throw new Error("WPT produced no report");
}

const { results }: WptReport = JSON.parse(readFileSync(reportPath, "utf8"));
const subtests = results.flatMap((fileResult) => fileResult.subtests);
const uniqueFiles = new Set(results.map((fileResult) => fileResult.test));

// These counts belong to the pinned revision; an incomplete run must not pass.
assert.equal(results.length, 58, "Expected all 58 WebMCP testharness files at the pin");
assert.equal(uniqueFiles.size, results.length, "WPT repeated a test file");
assert.equal(
  subtests.length,
  139,
  "WPT subtest count changed; inspect the report and expectations",
);
const statusCounts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOTRUN: 0, PRECONDITION_FAILED: 0 };
for (const { status } of subtests) {
  statusCounts[status] += 1;
}
console.log(
  `WPT: ${results.length} files; subtests ${JSON.stringify(statusCounts)}. Report: ${reportPath}`,
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
