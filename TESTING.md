# Testing

## Results

**226 browser tests pass** across Chromium 153.0.8010.12, Firefox 155.0, and
Playwright WebKit 26.6. Package checks also pass: imports, types, SSR, and tarball contents.
CI runs these checks plus WPT in Chrome, Firefox, and actual Safari. Safari runs on
`macos-26`; Playwright WebKit is a separate build.

WPT covers **all 67 WebMCP testharness files, 161 subtests**, with zero unexpected results:

| Subtest result | Chrome / Firefox | Safari |
| --- | ---: | ---: |
| PASS | 96 | 92 |
| Expected FAIL | 23 | 27 |
| Expected TIMEOUT | 24 | 24 |
| Expected NOTRUN | 18 | 18 |

Tested with Chrome Canary 156.0.8068.0, Firefox Nightly 158.0a1 (20260922211342),
Firefox 142.0.1, and Safari 26.6.2 (21624.5.1.11.3) on macOS 26.6.2.
At the file level: 42 OK, 24 expected timeouts, one expected error.

Expected failures are still failures. `NOTRUN` means an earlier timeout prevented
the test from running, including three abort cases. Passing declarative checks only
cover rejection or absence of tools. All 22 pinned IDL checks pass, but that IDL
predates `debugging` and lifecycle events. This is not full conformance.

## Run locally

Use Node.js 24 and pnpm. Leave port 8793 free for the fixture server.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test
pnpm test:package
```

`pnpm test` runs lint, build, type checking, and browser tests. Polyfill tests disable
native WebMCP. A separate Chromium test uses `--enable-features=WebMCP` to check
that loading the polyfill preserves the native context and its tools.

WPT needs Python 3.11+ and a clean checkout at
[`2699eaa`](https://github.com/web-platform-tests/wpt/commit/2699eaa2e5f906eda4d7443f7080c3de19e62365).
The [CI workflow](.github/workflows/test.yml) has the sparse-checkout and dependency setup.

```sh
WPT_ROOT=../wpt CHROME_BIN=/path/to/chrome-canary pnpm test:wpt
WPT_ROOT=../wpt WPT_BROWSER=firefox pnpm test:wpt
WPT_ROOT=../wpt WPT_BROWSER=safari pnpm test:wpt
```

Firefox downloads Nightly unless `FIREFOX_BIN` is set. The runner enables
`dom.origin_agent_cluster.default` in the test profile because the pinned pages
assume origin keying without a header; [Firefox defaults to site keying](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_142_0_1_RELEASE/modules/libpref/init/StaticPrefList.yaml#L5768-L5773).
Local fixtures test explicit `Origin-Agent-Cluster` headers.
Safari requires macOS, [Remote Automation, and WPT hosts-file setup](https://web-platform-tests.org/running-tests/safari.html).

Set `WPT_PYTHON` or `WPT_VENV` to use an existing Python environment. Extra arguments
go to WPT. On macOS, Firefox may need `--certutil-binary` pointing to a wrapper that
unsets `DYLD_LIBRARY_PATH` before calling Homebrew's `certutil`.

Reports go to `wpt-results/<browser>.json`. Upstream tests stay unmodified;
[expectations](wpt/metadata/) record known failures and their reasons. Unexpected
passes, unexpected failures, and incomplete runs fail the command. Crashtests and
other non-testharness files are outside this suite.

## Draft alignment and limitations

Checked against [draft `f5645e9`](https://github.com/webmachinelearning/webmcp/blob/f5645e9aea51eb589599f181d104a2f49430608e/index.bs)
and `webmcp-types@0.1.9`.

- **Missing APIs:** declarative forms, CSS states, and lifecycle events are not
  implemented. This includes both the draft's `ModelContext` events and the older
  `window` events WPT expects.
- **Draft differences:** results are JSON-serialized; some pinned tests expect raw
  strings. Omitted or `undefined` input becomes `{}`, matching the types and pinned
  IDL rather than the recorded draft. `null` and primitives reject.
- **Timing:** MessagePorts approximate native task ordering. Aborting before
  dispatch skips the callback; the draft dispatches and then aborts its signal.
  Delegated permission checks are asynchronous, so argument errors can precede
  `NotAllowedError`.
- **Safari:** the tested version lacks `originAgentCluster`, so the polyfill skips
  that check. Four WPT assertions fail with `NotAllowedError` instead of
  `SecurityError`. [WebKit's implementation](https://github.com/WebKit/WebKit/pull/66162)
  landed behind a flag.
- **Frames:** each participating document must load the polyfill. Native contexts
  and WPT's uninstrumented blank helper documents cannot answer its messages.
  Opaque-origin handshakes and inaccessible cross-origin shadow frames are
  unsupported; closed shadow trees limit discovery and ordering.
- **Deadlines:** initial discovery, handshakes, and discovery or permission replies
  wait up to 500 ms. Late peers can be absent from results. Callbacks and
  `toolchange` listeners have no deadline, so an unresponsive peer can leave a call
  pending. Navigation cleanup depends on `pagehide`; removed frames are polled
  every 100 ms. Background suspension affects timing.
- **Tool removal:** a disappearing frame emits no `toolchange`; later discovery
  excludes it.
- **Policy and origins:** without native policy introspection, only accessible
  iframe delegation can be checked, not HTTP Permissions Policy. Cross-origin
  ancestors must also load the polyfill. Navigation inheritance is approximate;
  browser-specific trusted schemes and opaque execution origins are unsupported.

When updating the pins, compare the [draft](https://webmachinelearning.github.io/webmcp/),
[WPT](https://github.com/web-platform-tests/wpt/tree/master/webmcp), and
[types](https://github.com/webmachinelearning/webmcp-types). Update `wpt/revision.txt`,
the counts in `wpt/run.ts`, and each affected expectation after reviewing the changes.
[Blink source](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/script_tools/)
is a reference for Chromium behavior.
