# WebMCP polyfill

A polyfill for [WebMCP](https://webmachinelearning.github.io/webmcp/), with types from [webmcp-types](https://github.com/webmachinelearning/webmcp-types) and no runtime JavaScript dependencies.

## Build

This package is under review. To try it locally, build this checkout with Node.js 24 and pnpm:

```sh
pnpm install
pnpm build
```

Then install the checkout in your app with `pnpm add /path/to/webmcp-polyfill`. For a classic script, serve the built `dist/polyfill.js`.

## Usage

Serve your page over HTTPS with the `Origin-Agent-Cluster: ?1` response header. Localhost HTTP also works for development.

Load the polyfill before registering tools:

```ts
import "webmcp-polyfill/auto";

const context = document.modelContext;
if (!context) throw new Error("WebMCP requires a secure browser context");

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

const [tool] = await context.getTools();
console.log(await context.executeTool(tool, {})); // {"title":"WebMCP demo"}

// Remove the tool when it is no longer needed.
registration.abort();
```

To install explicitly, import and call `installWebMCP` from `webmcp-polyfill`. Installation requires a secure browser context and leaves an existing `document.modelContext` unchanged, including partial native implementations. It affects only the realm that calls it, so each frame installs separately.

## Scope

Tools stay in the current document. Cross-document tools, declarative forms, lifecycle window events, and browser agent integration aren't implemented. Nonempty `exposedTo` and `fromOrigins` options reject.

`executeTool()` accepts an object and returns a JSON-serialized result. Callbacks must validate their inputs; schema inference provides TypeScript checks only.

The implementation follows [draft source `cc45efc`](https://github.com/webmachinelearning/webmcp/blob/cc45efcaf0/index.bs). Of the 56 selected assertions of the [upstream WPT](https://github.com/web-platform-tests/wpt/tree/1a21db90adf8a264370ad806ed761f39e1d435a0/webmcp) at the pin, 51 pass and five fail where the pinned tests disagree with the draft's `executeTool()` input and result rules. [TESTING.md](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md) records each one and what the selection excludes.

The API tracks the draft. Breaking changes ship with notes: in minor releases while the version is 0.x, in majors after 1.0.

## Development

See [TESTING.md](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md) for browser setup, test commands, draft alignment, and known limitations.

## License

[MIT](LICENSE).
