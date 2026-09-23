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
that installation preserves its context and registered tools, with only the
`WebMCP` Blink feature explicitly enabled.
Browser tests in `tests/*.test.ts` are discovered automatically.
`tests/native.test.ts` runs only in the native Chromium project;
`tests/package.test.ts` runs separately through `pnpm test:package`.
All source, tests, and Node scripts are type-checked, including the browser
fixture JavaScript through `checkJs`. Node 24 runs the TypeScript scripts directly;
they use erasable syntax and need no separate compilation step.

| File                    | Coverage                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `tests/index.test.ts`   | Registration, discovery, conversion, metadata copies, events, abort, and detached documents |
| `tests/execute.test.ts` | Object input, JSON results, cancellation, concurrent calls, and dispatch failures           |
| `tests/frames.test.ts`  | Frame discovery, exposure, delegated permissions, routing, cancellation, and navigation     |
| `tests/app.test.ts`     | Button interactions, callback side effects, invalid input, unregistration, and reload       |
| `tests/native.test.ts`  | Preservation of the native context, getter, and tools                                       |
| `tests/index.test-d.ts` | Published declarations and upstream schema inference                                        |
| `tests/package.test.ts` | Packed consumer imports, type inference, SSR entry points, and package contents             |

The fixture server, `tests/fixtures/server.ts`, uses port 8793 and loopback HTTP,
which is a secure context. It sends `Origin-Agent-Cluster: ?1` for consistent setup
and `?0` on the opt-out fixture. The header is optional in current Chrome's default
configuration.
Playwright requires a free port and retains failure traces. Its bundled WebKit
provides engine coverage; it is not Safari.

The last recorded Playwright run passed **226 tests** across Chromium
153.0.8010.12, Firefox 155.0, and WebKit 26.6, including the native Chromium check.
These are the package's browser tests; upstream WPT results are recorded separately
below.

## Upstream WPT

Use Python 3.11+ and a clean WPT checkout at
[`2699eaa2e5f906eda4d7443f7080c3de19e62365`](https://github.com/web-platform-tests/wpt/commit/2699eaa2e5f906eda4d7443f7080c3de19e62365).
CI and the local runner both read the pin from `wpt/revision.txt`.
A sparse checkout needs `common`, `docs`, `interfaces`, `resources`, `tools`,
and `webmcp`, plus the root files. CI includes the checkout recipe.

```sh
WPT_ROOT=../wpt CHROME_BIN=/path/to/chrome-canary pnpm test:wpt
WPT_ROOT=../wpt WPT_BROWSER=firefox pnpm test:wpt
WPT_ROOT=../wpt WPT_BROWSER=safari pnpm test:wpt
```

The default browser is Chrome Canary. The Firefox target downloads Nightly into
WPT's environment; set `FIREFOX_BIN` to test an existing Firefox installation.
Firefox uses `dom.origin_agent_cluster.default=true` in its temporary test profile.
The pinned WebMCP pages omit the `Origin-Agent-Cluster` header and assume origin
keying by default, while [Firefox defaults to site keying](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_142_0_1_RELEASE/modules/libpref/init/StaticPrefList.yaml#L5768-L5773).
Without that preference, registration rejects with `SecurityError` before most
tests can exercise WebMCP behavior. Explicit `Origin-Agent-Cluster: ?0` helper
responses still opt out, and the local browser fixtures test the header itself.

The Safari target uses the system Safari on macOS and runs serially. It requires
[Safari Remote Automation and WPT hosts-file setup](https://web-platform-tests.org/running-tests/safari.html).
The runner does not change either system setting. Safari is an actual WebKit WPT
target; Playwright's bundled WebKit is tested separately by `pnpm test`.

`WPT_PYTHON` and `WPT_VENV` optionally select the interpreter and environment.
Additional arguments go to the official WPT runner, for example
`pnpm test:wpt --certutil-binary=/path/to/certutil` for Firefox certificate setup.
On macOS, WPT's library path can make Homebrew's `certutil` load incompatible NSS
libraries bundled with Firefox. The recorded Firefox runs used a local `certutil`
wrapper that cleared `DYLD_LIBRARY_PATH` before invoking Homebrew's executable;
the wrapper is outside the repository and was selected with `--certutil-binary`.
CI installs Linux browser libraries with Playwright's dependency installer.
On Ubuntu, CI installs an [AppArmor profile](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)
for Chrome to create its sandbox and NSS certificate tools for Firefox.
CI runs Chrome and Firefox independently and retains both reports.

`wpt/run.ts` selects **every testharness test under `/webmcp`**, including
declarative and cross-document tests. Other WPT test types, such as crashtests,
are outside this lane. Chrome's native WebMCP is disabled. WPT injects the built
polyfill in every browser; upstream test sources remain unchanged.

`wpt/metadata/` contains standard WPT expectations with a reason for each
affected file. Unexpected failures and unexpected passes fail the command.
File and subtest counts catch missing coverage and early harness exits.
Results and browser details are written to `wpt-results/<browser>.json`.

### Recorded results

Chrome Canary 156.0.8068.0, Firefox Nightly 158.0a1 (build 20260922211342),
and Firefox 142.0.1 each report **67 files and 161 subtests**. Safari 26.6.2
(21624.5.1.11.3) on macOS 26.6.2 covers the same tests. Each final run has zero
unexpected results:

| Subtest result   | Chrome / Firefox | Safari |
| ---------------- | ---------------: | -----: |
| PASS             |               96 |     92 |
| Expected FAIL    |               23 |     27 |
| Expected TIMEOUT |               24 |     24 |
| Expected NOTRUN  |               18 |     18 |

At the file level, 42 harnesses finish with OK, 24 time out, and one reports an
expected error. All 22 subtests in the pinned IDL suite pass; its IDL
predates the `debugging` annotation and lifecycle event interfaces. These results
do not establish full WebMCP conformance.

Safari 26.6.2 does not expose `window.originAgentCluster`, including on pages with
`Origin-Agent-Cluster: ?1` or `?0`. Four `document-domain-enabled` assertions
therefore fail: the cross-origin helpers reject with `NotAllowedError` from the
tools policy fallback instead of the earlier `SecurityError` for agent clustering.
Safari-only expectations record these failures; the assertions still require a
pass in Chrome and Firefox. [WebKit's implementation](https://github.com/WebKit/WebKit/pull/66162)
landed behind a feature flag, so bundled Playwright WebKit coverage does not
establish availability in system Safari.

`NOTRUN` means an earlier subtest timed out before that subtest could run, so WPT
shows nothing about that behavior, including three abort cases in
`imperative/executeTool-abort`. The local browser suite covers same-document
cancellation without lifecycle events.

The passing declarative subtests do not show declarative support. Three in
`no-frame-documents` assert only that nothing registers. In Chrome and Firefox,
`document-domain-enabled` also passes on its `SecurityError` assertion.

### Why tests fail

- **Result serialization:** some pinned tests expect raw string results. The
  polyfill JSON-serializes callback results, as the draft requires. Each affected
  subtest has an expectation.
- **Declarative tools and lifecycle events:** form registration, CSS states, and
  `toolactivated`/`toolcancel` events are not implemented. Tests waiting for
  them time out; later subtests may not run.
- **Helper frames:** WPT injects into testharness pages, not initial `about:blank`
  documents, `window.open('about:blank')`, or `/common/blank.html`. Those documents
  have no polyfill. Local tests install it in real served frames to exercise detachment.
- **Permissions Policy:** native `tools` policy is checked when exposed by the
  browser. The fallback evaluates iframe `allow` and inherited delegation, but
  cannot inspect HTTP Permissions Policy when the browser does not expose it.

## Draft alignment and limitations

The implementation was checked against
[draft source `f5645e9`](https://github.com/webmachinelearning/webmcp/blob/f5645e9aea51eb589599f181d104a2f49430608e/index.bs).
Public declarations and the current implementation target come directly from
`webmcp-types@0.1.9`, including the `debugging` annotation. The draft's new
`ToolActivatedEvent`, `ToolCancelEvent`, and associated `ModelContext` handlers are
not implemented, and neither are the older `window` events that pinned WPT still
expects.

`executeTool(tool)` and `executeTool(tool, undefined, options)` pass a fresh empty
object to the callback, matching `optional object inputObject = {}` in the pinned
WPT IDL and the optional input in `webmcp-types@0.1.9`. This is a deliberate
difference from the recorded draft's non-object rejection step.
Explicit `null` and primitive inputs still reject with `TypeError`.

Message-port tasks approximate the WebMCP task source; zero-delay timers would be
clamped to 4 ms when calls are chained. Task ordering and native abort
algorithms are not fully reproduced. An invocation aborted
before dispatch never starts its callback; the draft dispatches and then cancels
through the callback's signal.

Operations reject when `originAgentCluster` is false, except for `file:`
documents. Browsers without that property skip the check. Origin validation uses
URL parsing and scheme/host checks; browser-specific trusted schemes are not
recognized, and a URL with an opaque origin, such as `file:`, is rejected.
Callbacks must validate their inputs.

Frames find each other with `webmcp-polyfill:` string messages on `window`. A
document announces itself to the rest of its frame tree when the polyfill installs.
Only documents that have announced or answered are sent requests. A frame without
the polyfill receives announcements and can ignore them; after the initial discovery
wait described below, it adds no request delay. The polyfill's listener consumes
messages in that namespace before the application's `message` listeners run.

Frame communication authenticates the initial window message's source and origin,
then sends requests over a transferred `MessagePort`. Discovery and execution
check exposure at the owner. Incoming requests also check the caller's inherited
iframe permission, so bypassing the public methods does not bypass delegation.
Same-origin tools remain visible when `fromOrigins` requests additional origins.

Frame limitations:

- Every participating document must load the polyfill. Preserved native contexts
  and uninstrumented helper frames cannot answer its protocol.
- A document installed while other frames exist waits once, for up to 500 ms, for
  their answers before its first discovery, notification, or delegated permission
  check. A frame that installs the polyfill later is found when it announces itself.
- Handshakes and discovery or permission replies have a 500 ms deadline. A peer
  that misses the handshake is dropped until it answers a new announcement, and
  late peers may be absent from that discovery result. Tool callbacks and
  `toolchange` listeners run page-author code, so their replies have no deadline.
  After a successful handshake, a peer that never replies can leave execution or
  registration pending. Navigation does not necessarily release the request if
  the peer fails to send its cleanup message; removing the frame does.
- The polyfill closes its pending channels on `pagehide`; while requests are active,
  membership checks detect removed frames at 100 ms intervals. Hash navigation keeps calls alive.
  Timers and background-page suspension prevent exact native timing guarantees.
- Registration and explicit unregistration propagate `toolchange`. Implicit tool
  removal when an owner disappears does not currently emit a separate change event;
  subsequent discovery excludes the removed frame.
- The fallback can inspect accessible iframe `allow` attributes, including
  same-origin shadow frames. Cross-origin shadow frames whose container cannot be
  inspected, and opaque-origin frame handshakes, are not supported. Closed shadow
  trees also prevent complete ordering and discovery between unrelated frames.
- In browsers without native `tools` policy introspection, HTTP response policy
  and every navigation detail of policy inheritance cannot be reproduced. A
  cross-origin ancestor must run the polyfill to vouch for its frames, and any frame
  in the tree can ask it whether it delegates `tools` to one of its child frames for
  a given origin. That check is asynchronous, so it runs after the synchronous
  validation and JSON snapshots of `registerTool()` and `executeTool()`; a denied
  document reports those errors before `NotAllowedError`, where the draft checks
  permission first.

When updating the draft or WPT pin, compare the
[draft history](https://github.com/webmachinelearning/webmcp/commits/main/index.bs),
[upstream tests](https://github.com/web-platform-tests/wpt/tree/master/webmcp), and
[types](https://github.com/webmachinelearning/webmcp-types).
Use [Blink source](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/script_tools/)
for Chromium-specific details. Review every changed expectation, update
`wpt/revision.txt` and the runner's coverage counts, and record browser versions
and results separately.
