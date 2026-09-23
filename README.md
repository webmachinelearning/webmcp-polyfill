# WebMCP polyfill

A polyfill for [WebMCP](https://webmachinelearning.github.io/webmcp/), with types from [webmcp-types](https://github.com/webmachinelearning/webmcp-types) and no runtime JavaScript dependencies.

## Build

This package is in development. Build this checkout with Node.js 24 and pnpm:

```sh
pnpm install
pnpm build
```

Then install the checkout in your app with `pnpm add /path/to/webmcp-polyfill`. For a classic script, serve the built `dist/polyfill.js`.

## Usage

Serve your page over HTTPS, or localhost HTTP for development. Operations reject where the browser reports that origin-keyed agent clustering is off; current Chrome enables it by default, so an `Origin-Agent-Cluster: ?1` header is optional.

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

For explicit installation, import and call `installWebMCP` from `webmcp-polyfill`. It is safe to call repeatedly and during server-side rendering. Existing `document.modelContext` implementations are preserved, including partial native implementations. Each frame installs separately.

## Frames

Load the polyfill in each participating frame. Tools in same-origin frames are visible by default, including tools in parents and siblings. Tools with the same name in different frames remain separate; pass the discovered descriptor to `executeTool()` so it reaches the correct owner.

For cross-origin tools, delegate the `tools` permission on the iframe, register the tool with `exposedTo: [callerOrigin]`, and discover it with `getTools({ fromOrigins: [toolOrigin] })`. Same-origin tools are still included in that result.

```html
<iframe src="https://tools.example/app" allow="tools https://tools.example"></iframe>
```

Installing the polyfill announces the frame to the rest of its frame tree with `webmcp-polyfill:` string messages. Initial discovery waits up to 500 ms for existing frames to answer. Frames without the polyfill can ignore the announcements; they receive no subsequent requests.

Execution and cancellation use authenticated `MessageChannel` connections. Tool callbacks run in their owning frame. A caller's abort reason stays with the caller; the callback receives a separate signal with a default `AbortError`.

## Implementation status

The current target is the surface published by `webmcp-types@0.1.9`: registration, discovery, execution, cancellation, and `toolchange`, including frame exposure and origin filtering. Declarative forms and the newer `toolactivated`/`toolcancel` events are not implemented. Browser agent integration requires browser support.

Native contexts do not join the polyfill's channels. Permissions Policy and some frame lifecycle behavior have browser-dependent limits; see the [documented limitations](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md#draft-alignment-and-limitations).

`executeTool()` accepts an object and returns a JSON-serialized result. Omitted or `undefined` input defaults to a fresh empty object. Callbacks must validate their inputs; schema inference provides TypeScript checks only.

The implementation tracks the [Community Group draft](https://webmachinelearning.github.io/webmcp/). [TESTING.md](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md) records the draft and WPT revisions, test coverage, and known limitations.

Breaking API changes ship with notes: in minor releases while the version is 0.x, in majors after 1.0.

## Development

`src/` contains the polyfill and its automatic entry point. `tests/` contains the browser and package checks with their fixtures. `wpt/` contains the upstream test runner, pinned revision, and expectations.

See [TESTING.md](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md) for browser setup and test commands.

## License

[MIT](LICENSE).
