import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = process.env.WPT_ROOT;
const chrome = process.env.CHROME_BIN;
if (!root || !chrome)
  throw new Error("Set WPT_ROOT to a WPT checkout and CHROME_BIN to Chrome Canary");

const revision = readFileSync(new URL("./wpt-revision.txt", import.meta.url), "utf8").trim();
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.error) throw head.error;
if (head.status !== 0 || head.stdout.trim() !== revision) {
  throw new Error(`Check out WPT ${revision}; review upstream changes before changing the pin`);
}

const clean = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root });
if (clean.status !== 0) {
  throw new Error("WPT has tracked changes; restore the pinned sources before running conformance");
}

const report = fileURLToPath(new URL("./wpt-results/report.json", import.meta.url));
mkdirSync(dirname(report), { recursive: true });
rmSync(report, { force: true });
const result = spawnSync(
  process.env.WPT_PYTHON ?? "python3",
  [
    resolve(root, "wpt"),
    "--venv",
    process.env.WPT_VENV ?? resolve(root, "_venv_polyfill"),
    "run",
    "--channel",
    "canary",
    "--binary",
    chrome,
    "--yes",
    "--install-webdriver",
    "--headless",
    "--no-enable-experimental",
    "--test-types",
    "testharness",
    "--binary-arg=--disable-features=WebMCP",
    "--inject-script",
    fileURLToPath(new URL("./dist/polyfill.js", import.meta.url)),
    "--manifest",
    resolve(root, "MANIFEST.json"),
    "--metadata",
    fileURLToPath(new URL("./wpt-metadata", import.meta.url)),
    "--log-mach=-",
    "--log-wptreport",
    report,
    "--no-pause-after-test",
    "--processes",
    "4",
    "--no-manifest-download",
    "--include",
    "/webmcp",
    "chrome",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (!existsSync(report)) throw new Error("WPT produced no report");
const { results } = JSON.parse(readFileSync(report, "utf8"));
const subtests = results.flatMap((entry) => entry.subtests);
// Counts are tied to the pin. Catch missing files, retries, and prematurely stopped harnesses.
assert.equal(results.length, 58, "Expected all 58 WebMCP testharness files at the pin");
assert.equal(
  new Set(results.map(({ test }) => test)).size,
  results.length,
  "WPT repeated a test file",
);
assert.equal(
  subtests.length,
  139,
  "WPT subtest count changed; inspect the report and expectations",
);
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOTRUN: 0 };
for (const { status } of subtests) counts[status] = (counts[status] ?? 0) + 1;
console.log(`WPT: ${results.length} files; subtests ${JSON.stringify(counts)}. Report: ${report}`);
if (result.status !== 0) throw new Error(`WPT reported unexpected results (exit ${result.status})`);
