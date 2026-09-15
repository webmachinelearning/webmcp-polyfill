import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = process.env.WPT_ROOT;
const chrome = process.env.CHROME_BIN;
if (!root || !chrome)
  throw new Error("Set WPT_ROOT to a WPT checkout and CHROME_BIN to Chrome Canary");

const revision = "1a21db90adf8a264370ad806ed761f39e1d435a0";
// Pinned together with `revision` and `tests`; keep TESTING.md in sync.
const EXPECTED_ASSERTIONS = 27;
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.error) throw head.error;
if (head.status !== 0 || head.stdout.trim() !== revision) {
  throw new Error(`Check out WPT ${revision}; review upstream changes before changing the pin`);
}

const clean = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root });
if (clean.status !== 0) {
  throw new Error("WPT has tracked changes; restore the pinned sources before running conformance");
}

// Unmodified upstream registration/discovery tests. Execution and full IDL
// coverage belong to the executeTool follow-up.
const tests = [
  "imperative/register_tool_name_validation.https.html",
  "imperative/register_tool_signal.https.html",
  "imperative/register_tool_with_schema.https.html",
  "imperative/register_tool_no_schema.https.html",
  "imperative/register_tool_invalid_json_schema.https.html",
  "imperative/register_tool_toolchange.https.html",
  "imperative/duplicate_tool_registration.https.html",
  "imperative/getTools-imperative-schema.https.html",
  "imperative/model_context.https.html",
  "imperative/non-secure.html",
  "imperative/register-tool-title.https.html",
  "imperative/register_tool_with_empty_annotation.https.html",
  "imperative/getTools-imperative-annotations.https.html",
];
const report = fileURLToPath(new URL("./wpt-results/report.json", import.meta.url));
mkdirSync(dirname(report), { recursive: true });
rmSync(report, { force: true });
for (const test of tests) {
  const source = test.replace(/\.https\.window\.html$/, ".https.window.js");
  if (!existsSync(resolve(root, "webmcp", source)))
    throw new Error(`Missing WPT source: ${source}`);
}
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
    "--binary-arg=--disable-features=WebMCP,WebMCPTesting",
    "--inject-script",
    fileURLToPath(new URL("./dist/polyfill.js", import.meta.url)),
    "--manifest",
    resolve(root, "MANIFEST.json"),
    "--log-mach=-",
    "--log-wptreport",
    report,
    "--no-pause-after-test",
    "--processes",
    "1",
    "--no-manifest-download",
    ...tests.flatMap((test) => ["--include", `/webmcp/${test}`]),
    "chrome",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`WPT reported unexpected results (exit ${result.status})`);
if (!existsSync(report)) throw new Error("WPT produced no report");
const { results } = JSON.parse(readFileSync(report, "utf8"));
const actual = results.map(({ test }) => test).sort();
const expected = tests.map((test) => `/webmcp/${test}`).sort();
assert.deepEqual(
  actual,
  expected,
  "WPT selection did not run exactly once: inspect wpt-results/report.json",
);
const empty = results.filter((entry) => !entry.subtests.length).map(({ test }) => test);
if (empty.length) throw new Error(`WPT files ran no assertions: ${empty.join(", ")}`);
const assertions = results.reduce((count, entry) => count + entry.subtests.length, 0);
if (assertions !== EXPECTED_ASSERTIONS) {
  const counts = results.map(({ test, subtests }) => `  ${test}: ${subtests.length}`).join("\n");
  throw new Error(
    `Expected ${EXPECTED_ASSERTIONS} assertions at WPT ${revision}, got ${assertions}.\n${counts}\n` +
      "Fewer means a testharness file stopped early, which expected-failure metadata cannot " +
      "catch: fix the polyfill. More, or a deliberate change to `revision` or `tests`, means " +
      "updating EXPECTED_ASSERTIONS here and the counts in TESTING.md.",
  );
}
console.log(`WPT: ${results.length} files, ${assertions} assertions. Report: ${report}`);
