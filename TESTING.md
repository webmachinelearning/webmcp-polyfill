# Testing and upstream tracking

## Run the browser suite

Use Node.js 24, pnpm, and the Playwright browsers pinned by the lockfile:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test
pnpm test:package
```

| Check               | What it runs                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.test-d.ts`   | TypeScript against the built package declarations, including upstream schema inference                                                              |
| `index.test.ts`     | Built bundle served over HTTP in Chromium (native WebMCP disabled), Firefox, and WebKit; coercion, metadata, events, registration abort, errors, detached documents |
| `app.test.ts`       | A served application, real button interactions, discovery, unregistration, and reload                                                               |
| `native.test.ts`    | Real native Chromium registration, then polyfill loading; context and getter identities must survive                                                |
| `pnpm test:package` | Packed tarball installed into a fresh consumer, public type imports, SSR-safe entry points, and package contents                                    |
| `pnpm test:wpt`     | Unmodified upstream registration/discovery WPT in real Chrome Canary, with native WebMCP disabled                                                   |

The fixture server binds 127.0.0.1:8793 and sets the required `Origin-Agent-Cluster`
header; Playwright never reuses an existing server, so free that port first.
Loopback HTTP is a secure context;
the WPT `non-secure.html` case supplies the nonsecure-origin check. The browser
suite uses fresh contexts and real network responses, without route interception,
fake timers, DOM shims, or mocked tool callbacks.

Playwright retains failure traces and an HTML report in `playwright-report/`.
Playwright drives its bundled Firefox for page tests. WebKit is additional engine
coverage, not a claim that Safari itself was tested.

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
The runner checks the revision, rejects tracked source changes, requires all 13 selected files
to run exactly once, checks assertion counts, and retains `wpt-results/report.json`
with browser and upstream revisions. Runner errors, unexpected failures, and
unexpected passes fail the command, and nothing is retried.

At this pin, **all 27 selected assertions pass**, with no expected failures.

### Excluded coverage

Execution tests and the full IDL harness are deferred with `executeTool()`.
The IDL includes that method, so running the full shape suite against this
registration/discovery subset would intentionally fail. Keep that exclusion
explicit rather than adding expected failures for an API not yet included.

Cross-document discovery, frame-tree routing, declarative forms, browser
permissions integration, CSS states, navigation/BFCache, and lifecycle window
events are also outside this initial implementation.

WPT's `--inject-script` modifies testharness pages; it does not install the bundle
in `/common/blank.html` helper frames. Detached-frame WPT therefore cannot run
unchanged in this lane. The local test serves an instrumented iframe, removes
it, and checks registration, discovery, and exception realms.

## Where to look when upstream changes

| Source                                                                                                                                                                | Use                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Draft source and history](https://github.com/webmachinelearning/webmcp/commits/main/index.bs)                                                                        | Normative algorithms, Web IDL, open issues; compare with the revision below               |
| [WPT webmcp](https://github.com/web-platform-tests/wpt/tree/master/webmcp) and [results](https://wpt.fyi/results/webmcp)                                              | Executable assertions and native cross-browser results; these results are not polyfill results   |
| [WPT IDL](https://github.com/web-platform-tests/wpt/blob/master/interfaces/webmcp.idl)                                                                                | Generated interface snapshot; it can lag the published draft                                     |
| [Official types](https://github.com/webmachinelearning/webmcp-types)                                                                                                  | Public declarations, schema inference, and pending API updates                                   |
| [Blink script_tools](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/script_tools/)                                             | Chromium IDL, implementation, tests, and commit-linked bugs                                      |
| [Gecko source search](https://searchfox.org/mozilla-central/search?q=ModelContext) and [Mozilla position](https://github.com/mozilla/standards-positions/issues/1412) | Locate Firefox implementation work and discussion; a position is not evidence of shipped support |

Reproduce a disagreement before changing code or expectations, and record what
changed in the draft, types, WPT, and browser implementation separately.

## Lint

`pnpm lint` runs Oxlint with correctness checks, shadowing checks, and a ban on
explicit `any`. Warnings fail the command, and `pnpm test` runs it before compiling.

## Draft and types

The implementation was compared with [draft source `cc45efc`](https://github.com/webmachinelearning/webmcp/blob/cc45efcaf0/index.bs).
It uses timers to queue tasks; JavaScript cannot reproduce the browser's WebMCP
task source, nor the draft's abort *algorithms*, which run before an abort event
rather than as a listener.

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

To test types changes, keep `webmcp-types` beside this checkout and run
`pnpm link ../webmcp-types`, then `pnpm typecheck`. Restore the published
dependency with `pnpm install --force` before package checks. Do not commit
local dependency overrides.
