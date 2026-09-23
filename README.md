# WebMCP polyfill

A polyfill for [WebMCP](https://webmachinelearning.github.io/webmcp/), with types from [webmcp-types](https://github.com/webmachinelearning/webmcp-types) and no runtime JavaScript dependencies.

## Build

This package is in development. Build this checkout with Node.js 24 and pnpm:

```sh
pnpm install
pnpm build
```

Then install the checkout in your app with `pnpm add /path/to/webmcp-polyfill`.

## Usage

Use HTTPS or localhost. Some browsers need an `Origin-Agent-Cluster: ?1` header; current Chrome enables origin keying by default.

Load the polyfill before registering tools:

```ts
import "webmcp-polyfill/auto";

const context = document.modelContext;
if (!context) {
  throw new Error("WebMCP requires a secure browser context");
}

const registration = new AbortController();
await context.registerTool(
  {
    name: "page-title",
    description: "Get the title of this page",
    execute() {
      return { title: document.title };
    },
  },
  { signal: registration.signal },
);

const tools = await context.getTools();
const pageTitleTool = tools.find((tool) => tool.name === "page-title");
if (!pageTitleTool) {
  throw new Error("The page-title tool is unavailable");
}

const result = await context.executeTool(pageTitleTool);
console.log(result);

// Remove the tool when it is no longer needed.
registration.abort();
```

For explicit installation, call `installWebMCP()` from `webmcp-polyfill`. Repeated calls are safe. Both entry points preserve existing native contexts, including partial implementations.

### Script tag

Serve the built `dist/polyfill.js` before your app:

```html
<script src="/assets/polyfill.js"></script>
<script src="/assets/app.js"></script>
```

This standalone IIFE installs `document.modelContext` automatically.

### Next.js

In Next.js 15.3+, add this to `instrumentation-client.ts` beside `app` (or `src/instrumentation-client.ts` beside `src/app`):

```ts
import "webmcp-polyfill/auto";
```

Next.js runs [client instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client) before hydration. A Server Component import alone won't install the polyfill in the browser.

Configure `Origin-Agent-Cluster` through Next.js [`headers()`](https://nextjs.org/docs/app/api-reference/config/next-config-js/headers) if your browser needs it.

Both entry points are SSR-safe: installation does nothing without a document. Your pages can stay server-rendered; WebMCP runs in the browser.

The package needs no `"use client"` directive. Use it on your [Client Components](https://nextjs.org/docs/app/api-reference/directives/use-client) and access `document.modelContext` in effects or event handlers. Pass an `AbortSignal` when registering in an effect, then abort it during cleanup.

## Frames

Load the polyfill in each frame. Same-origin tools are visible by default, including those in parents and siblings. Pass the discovered descriptor to `executeTool()` so names shared by different frames reach the correct owner.

For cross-origin tools, delegate the `tools` permission on the iframe, register the tool with `exposedTo: [callerOrigin]`, and discover it with `getTools({ fromOrigins: [toolOrigin] })`. Same-origin tools are still included in that result.

```html
<iframe src="https://tools.example/app" allow="tools https://tools.example"></iframe>
```

Initial discovery waits up to 500 ms for existing frames. Requests use `MessageChannel` after checking the peer's source and origin; callbacks run in their owning frame. Cancellation preserves the caller's reason and sends the callback a default `AbortError`.

## Implementation status

The target is `webmcp-types@0.1.9`: registration, discovery, execution, cancellation, and `toolchange`, including frame exposure and origin filtering. Declarative forms and `toolactivated`/`toolcancel` are not implemented. Browser agent integration requires browser support.

Native contexts do not join the polyfill's channels. See [TESTING.md](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md) for policy and frame limitations, results, commands, and tracked revisions.

`executeTool()` accepts an object and returns a JSON-serialized result. Omitted or `undefined` input defaults to a fresh empty object. Callbacks must validate their inputs; schema inference provides TypeScript checks only.

Breaking API changes ship with notes: in minor releases while the version is 0.x, in majors after 1.0.

## Development

`src/` holds the polyfill, `tests/` the browser and package checks, and `wpt/` the upstream runner, pin, and expectations.

## License

[MIT](LICENSE).
