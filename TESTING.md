# Testing and upstream tracking

## Run the browser suite

Use Node.js 24, pnpm, and the Playwright browsers pinned by the lockfile:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test
pnpm test:package
```

The Firefox extension project additionally requires a stock Firefox and
[geckodriver](https://github.com/mozilla/geckodriver/releases). Put geckodriver
on PATH, or set `GECKODRIVER` to its executable. Set `FIREFOX_BIN` when Firefox
is not discoverable by geckodriver. CI installs both explicitly. No extension
signing preference is disabled: geckodriver installs a temporary development
add-on into a disposable profile.

For a focused run, use `pnpm build && pnpm exec playwright test --project=extension-firefox`
or `--project=extension-chromium`; every browser test loads the built bundle, so skipping the
build tests the previous one. Missing prerequisites fail that project.

| Check               | What it runs                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.test-d.ts`   | TypeScript against the built package declarations, including upstream schema inference                                                                          |
| `index.test.ts`     | Built bundle served over HTTP in Chromium (native WebMCP disabled), Firefox, and WebKit; coercion, metadata, events, errors, detached documents                  |
| `execute.test.ts`   | The same three engines: object input, JSON results, cancellation, concurrent calls, and dispatch-time failures                                                   |
| `app.test.ts`       | A served application, real button interactions, callback side effects, invalid input, unregistration, and reload                                                 |
| `native.test.ts`    | Real native Chromium registration, then polyfill loading; context and getter identities must survive                                                             |
| `extension.test.ts` | Real MV3 extension in Chromium and stock Firefox: MAIN installation, isolated notifications, background scripting calls, page state, re-registration, reload, and an unmatched origin |
| `pnpm test:package` | Packed tarball installed into a fresh consumer, public type imports, SSR-safe entry points, and package contents                                                 |
| `pnpm test:wpt`     | Unmodified upstream WPT and IDL in real Chrome Canary, with native WebMCP disabled                                                                               |

The fixture server binds 127.0.0.1:8793 and sets the required `Origin-Agent-Cluster`
header; Playwright never reuses an existing server, so free that port first.
Geckodriver picks its own loopback port. Loopback HTTP is a secure context;
the WPT `non-secure.html` case supplies the nonsecure-origin check. The browser
suite uses fresh contexts and real network responses, without route interception,
fake timers, DOM shims, or mocked extension APIs. The extension fixture executes
the integration guide's discovery/invocation example directly.

Playwright retains failure traces and an HTML report in `playwright-report/`.
Firefox extension runs attach the browser version, a page screenshot, and
geckodriver logs. Page tests use Playwright's bundled Firefox. Extension tests use stock Firefox
over Selenium, because Playwright loads extensions only in Chromium. WebKit is
engine coverage, not a claim that Safari was tested.

## Run upstream WPT

Use Python 3.11+, Chrome Canary, and a WPT checkout at
`1a21db90adf8a264370ad806ed761f39e1d435a0`. A sparse checkout needs `common`,
`docs`, `interfaces`, `resources`, `tools`, and `webmcp` plus the root files.
The CI workflow contains the exact checkout recipe. On Ubuntu, CI installs an
[AppArmor profile](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)
for the downloaded Chrome binary so it can create its sandbox using user
namespaces. The profile applies only to that executable.

```sh
WPT_ROOT=../wpt CHROME_BIN=/path/to/chrome-canary pnpm test:wpt
```

`WPT_PYTHON` and `WPT_VENV` optionally select the interpreter and environment.
The runner checks the revision, rejects tracked source changes, requires all 18 selected files
to run exactly once, checks assertion counts, and retains `wpt-results/report.json`
with browser and upstream revisions. Runner errors, unexpected failures, and
unexpected passes fail the command, and nothing is retried.

At this pin, 56 assertions run: **51 pass and five have explicit expected FAIL
metadata**. All 22 IDL assertions pass. API shape coverage does not prove runtime
defaults or complete conformance.

### Known draft disagreements

The [published draft](https://webmachinelearning.github.io/webmcp/#dom-modelcontext-executetool)
accepts optional `any inputObject`, rejects non-objects, and has no `{}` default.
It also JSON-serializes callback results, including strings. The pinned WPT
expects a default object and raw string results in the following cases:

| Upstream file                                       | Expected failures                                                                                            | Local coverage                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `executeTool-invalid-dictionary.https.html`         | Missing tool invoked without input expects `UnknownError`, rather than the draft's earlier input `TypeError` | Descriptor validation and input errors                                             |
| `executeTool-error-window-onerror.https.html`       | Both cases omit input and expect execution to start                                                          | Explicit object input, callback/serialization failures, and absence of page errors |
| `executeTool-unregister-resolution-race.https.html` | Invocation omits input                                                                                       | Unregistration during an invocation and its successful result                      |
| `object-arguments.https.html`                       | Expects an unquoted string result; also expects omitted input to become `{}`                                 | Array/object inputs, rejected primitive inputs, and JSON result serialization      |

These are five assertions in four files, recorded individually in `wpt-metadata`.
The pin, [1a21db9](https://github.com/web-platform-tests/wpt/commit/1a21db90adf8a264370ad806ed761f39e1d435a0),
is the WPT export of the Chromium change for
[spec PR #246](https://github.com/webmachinelearning/webmcp/pull/246) and
[#251](https://github.com/webmachinelearning/webmcp/pull/251), and it rewrote all four of these
files. The draft's input and result rules have not changed since #251 merged, so these are not
stale tests awaiting an update: four of the assertions invoke `executeTool()` with no input,
which the draft rejects with a `TypeError` before it looks the tool up, and `object-arguments`
asserts an unquoted `"Success"` from a callback whose result the draft JSON-serializes. Re-read the live
draft before changing any expectation. An expected failure can stop at its first assertion, so
the local tests cover the behavior after that point.

`webmcp-types` PR #3 and the augmentation in `index.ts` both declare `inputObject?: object`,
which is narrower than the IDL's `any`: omitting the argument type-checks and then rejects at
runtime, as the draft requires.

### Excluded coverage

Cross-document discovery/execution, frame-tree routing, navigation cancellation,
declarative forms, browser permissions integration, CSS states, and lifecycle
window events are outside this initial implementation. The pinned
`executeTool-abort.https.html` is excluded rather than carried as expected
failures: its second subtest waits forever on a `toolactivated` event that the
draft still leaves [unspecified](https://github.com/webmachinelearning/webmcp/issues/146),
so the file times out and its last three subtests never run at all. Expected-failure
metadata cannot express that, and cancellation is exercised directly in all three
engines instead.
`exposedTo-invalid-origins.https.html` is excluded for the `exposedTo` divergence
recorded below, not for cross-document routing.

WPT's `--inject-script` modifies testharness pages; it does not install the bundle
in `/common/blank.html` helper frames. Detached-frame WPT therefore cannot run
unchanged in this lane. The local test serves an instrumented iframe, removes
it, and checks all three operations and exception realms.

## Where to look when upstream changes

| Source                                                                                                                                                                                                                                               | Use                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Draft source and history](https://github.com/webmachinelearning/webmcp/commits/main/index.bs)                                                                                                                                                       | Normative algorithms, Web IDL, open issues; compare with the revision below               |
| [WPT webmcp](https://github.com/web-platform-tests/wpt/tree/master/webmcp) and [results](https://wpt.fyi/results/webmcp)                                                                                                                             | Executable assertions and native cross-browser results; these results are not polyfill results   |
| [WPT IDL](https://github.com/web-platform-tests/wpt/blob/master/interfaces/webmcp.idl)                                                                                                                                                               | Generated interface snapshot; it can lag the published draft                                     |
| [Official types](https://github.com/webmachinelearning/webmcp-types)                                                                                                                                                                                 | Public declarations, schema inference, and pending API updates                                   |
| [Blink script_tools](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/script_tools/)                                                                                                                            | Chromium IDL, implementation, tests, and commit-linked bugs                                      |
| [Gecko source search](https://searchfox.org/mozilla-central/search?q=ModelContext) and [Mozilla position](https://github.com/mozilla/standards-positions/issues/1412)                                                                                | Locate Firefox implementation work and discussion; a position is not evidence of shipped support |
| [Firefox extension worlds](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts) and [scripting](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript) | Browser extension integration and serialization boundaries                                       |

Reproduce a disagreement before changing code or expectations, and record what
changed in the draft, types, WPT, and browser implementation separately.

## Lint

`pnpm lint` runs Oxlint with correctness checks, shadowing checks, and a ban on
explicit `any`. Warnings fail the command, and `pnpm test` runs it before compiling.

## Draft and types

The implementation was compared with [draft source `cc45efc`](https://github.com/webmachinelearning/webmcp/blob/cc45efcaf0/index.bs).
It uses timers to queue tasks; JavaScript cannot reproduce the browser's WebMCP
task source, nor the draft's abort *algorithms*, which run before an abort event
rather than as a listener. One consequence is observable: a signal aborted before
the dispatch timer fires rejects the caller and never runs the callback, where the
draft dispatches to the target document and then cancels through the callback's own
signal.

The runtime checks the `tools` Permissions Policy when the browser exposes it.
No engine lists `tools` in `permissionsPolicy.features()` today, so that branch
is currently inert and cross-origin frames are denied by the same-origin
fallback, which stands in for the feature's `self` default allowlist: it denies a
cross-origin frame the embedder allowed, and allows a same-origin frame the
embedder denied. Operations reject with `SecurityError` when `originAgentCluster`
is false, except in `file:` documents; where the property is absent the check is
skipped. Schema inference does not validate callback inputs at runtime.

Non-empty `exposedTo` and `fromOrigins` reject with `NotSupportedError`. The
draft would validate the origins and then resolve, since a document-local
implementation has nowhere to expose a tool to; rejecting keeps the polyfill from
implying cross-document support it does not have. Origins are validated first, so
an untrustworthy one still fails with the `SecurityError` the draft requires.

`webmcp-types@0.1.7` does not declare `executeTool()`. The method augmentation
in `index.ts` is temporary; remove it when [types PR #3](https://github.com/webmachinelearning/webmcp-types/pull/3)
is included in a release.

To test types changes, keep `webmcp-types` beside this checkout and run
`pnpm link ../webmcp-types`, then `pnpm typecheck`. Restore the published
dependency with `pnpm install --force` before package checks. Do not commit
local dependency overrides.
