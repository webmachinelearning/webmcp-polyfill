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

Serve your page over HTTPS, or localhost HTTP for development. Origin-keyed agent clustering must be enabled; current Chrome enables it by default, so an `Origin-Agent-Cluster: ?1` header is optional.

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

const result = await context.executeTool(pageTitleTool, {});
console.log(result);

// Remove the tool when it is no longer needed.
registration.abort();
```

For explicit installation, import and call `installWebMCP` from `webmcp-polyfill`. It is safe to call repeatedly and during server-side rendering. Existing `document.modelContext` implementations are preserved, including partial native implementations. Each frame installs separately.

## Scope

Tools stay in the current document. Cross-document tools, declarative forms, lifecycle window events, and browser agent integration aren't implemented. Nonempty `exposedTo` and `fromOrigins` options reject.

`executeTool()` accepts an object and returns a JSON-serialized result. Callbacks must validate their inputs; schema inference provides TypeScript checks only.

The implementation tracks the [Community Group draft](https://webmachinelearning.github.io/webmcp/). [TESTING.md](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md) records the draft and WPT revisions, test coverage, and known limitations.

Breaking API changes ship with notes: in minor releases while the version is 0.x, in majors after 1.0.

## Development

See [TESTING.md](https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md) for browser setup and test commands.

## License

[MIT](LICENSE).
