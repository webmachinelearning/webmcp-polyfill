# Testing and upstream tracking

## Browser and package checks

Use Node.js 24 and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test
pnpm test:package
```

`pnpm test` runs lint, builds the bundle, checks TypeScript, and runs Playwright.
Tests load the built bundle from a real server in Chromium, Firefox, and WebKit.
Chromium runs with native WebMCP disabled; a separate native Chromium test checks
that installation preserves its context and registered tools.

| File               | Coverage                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `index.test.ts`    | Registration, discovery, conversion, metadata copies, events, abort, and detached documents |
| `execute.test.ts`  | Object input, JSON results, cancellation, concurrent calls, and dispatch failures           |
| `app.test.ts`      | Button interactions, callback side effects, invalid input, unregistration, and reload       |
| `native.test.ts`   | Preservation of the native context, getter, and tools                                       |
| `index.test-d.ts`  | Published declarations and upstream schema inference                                        |
| `package.test.mjs` | Packed consumer imports, type inference, SSR entry points, and package contents             |

The fixture server uses port 8793 and loopback HTTP, which is a secure context.
It sends `Origin-Agent-Cluster: ?1` for consistent setup and `?0` on the opt-out
fixture. The header is optional in current Chrome's default configuration.
Playwright requires a free port and retains failure traces. Its bundled WebKit
provides engine coverage; it is not Safari.

## Upstream WPT

Use Python 3.11+, Chrome Canary, and a clean WPT checkout at
[`1a21db90adf8a264370ad806ed761f39e1d435a0`](https://github.com/web-platform-tests/wpt/commit/1a21db90adf8a264370ad806ed761f39e1d435a0).
A sparse checkout needs `common`, `docs`, `interfaces`, `resources`, `tools`,
and `webmcp`, plus the root files. CI includes the checkout recipe.

```sh
WPT_ROOT=../wpt CHROME_BIN=/path/to/chrome-canary pnpm test:wpt
```

`WPT_PYTHON` and `WPT_VENV` optionally select the interpreter and environment.
On Ubuntu, CI installs an [AppArmor profile](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)
for Chrome to create its sandbox.

The runner selects **every testharness test under `/webmcp`**, including
declarative and cross-document tests. Other WPT test types, such as crashtests,
are outside this lane. Native WebMCP is disabled and WPT injects the built
polyfill. Upstream test sources remain unchanged.

`wpt-metadata/` contains standard WPT expectations with a reason for each
affected file. Unexpected failures and unexpected passes fail the command.
File and subtest counts catch missing coverage and early harness exits.
Results and browser details are written to `wpt-results/report.json`.

### Recorded results

Chrome Canary 156.0.8062.0 reports **58 files and 139 subtests**:

| Subtest result   | Count |
| ---------------- | ----: |
| PASS             |    72 |
| Expected FAIL    |    23 |
| Expected TIMEOUT |    25 |
| Expected NOTRUN  |    19 |

At the file level, 32 harnesses finish with OK, 25 time out, and one reports an
expected setup error. All 22 IDL subtests pass. These results do not establish
full WebMCP conformance.

`NOTRUN` means an earlier subtest timed out before that subtest could run.
It is recorded separately from executed tests. The local browser suite covers
same-document cancellation and unregistration without lifecycle events.

### Why tests fail

- **Draft disagreements:** some pinned tests omit `executeTool()` input or expect
  raw string results. The draft rejects non-object input, including omitted input,
  and JSON-serializes callback results. Each affected subtest has an expectation.
- **Cross-document behavior:** tools and events stay in one document. Exposure,
  frame-tree discovery, routing, and navigation cancellation are unsupported.
- **Declarative tools and lifecycle events:** form registration, CSS states, and
  `toolactivated`/`toolcancel` events are not implemented. Tests waiting for
  them time out; later subtests may not run.
- **Helper frames:** WPT injects into testharness pages, not initial `about:blank`
  documents or `/common/blank.html`. Those frames have no polyfill. Local tests
  install it in real served frames to exercise detachment.
- **Permissions Policy:** the polyfill checks the `tools` policy when the browser
  exposes it. Otherwise, same-origin access approximates the default allowlist.
  That fallback cannot honor an explicit denial or cross-origin permission.

## Draft alignment and limitations

The implementation was checked against
[draft source `df2d824`](https://github.com/webmachinelearning/webmcp/blob/df2d824e2cd2cbf8e15e25dad9dfe85d20e25082/index.bs).
Its change from the earlier `cc45efc` reference documents Permissions Policy
mitigation; API algorithms are unchanged. Public declarations come directly
from `webmcp-types@0.1.8`.

Timers approximate the WebMCP task source. Exact task ordering, navigation
cleanup, and native abort algorithms cannot be reproduced. An invocation aborted
before dispatch never starts its callback; the draft dispatches and then cancels
through the callback's signal.

Operations reject when `originAgentCluster` is false, except for `file:`
documents. Browsers without that property skip the check. Origin validation uses
URL parsing and scheme/host checks; browser-specific trusted schemes are not
recognized. Nonempty `exposedTo` and `fromOrigins` reject with
`NotSupportedError` after origin validation. Callbacks must validate their inputs.

When updating the draft or WPT pin, compare the
[draft history](https://github.com/webmachinelearning/webmcp/commits/main/index.bs),
[upstream tests](https://github.com/web-platform-tests/wpt/tree/master/webmcp), and
[types](https://github.com/webmachinelearning/webmcp-types).
Use [Blink source](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/script_tools/)
for Chromium-specific details. Review every changed expectation, update both the
runner and CI pin, and record browser versions and results separately.
