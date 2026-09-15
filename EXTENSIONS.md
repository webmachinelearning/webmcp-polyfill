# Add WebMCP to an existing extension

Install the polyfill in the page's **MAIN** world. An isolated content script has its own JavaScript globals and cannot install or read the page's `document.modelContext`. Keep extension APIs, credentials, and permission decisions in the extension's isolated context.

## Install at document start

Copy the built `dist/polyfill.js` into your extension as `webmcp-polyfill.js`. It is minified; `dist/index.js` is the same implementation unminified if you need to read it. Add this entry to your existing manifest, replacing the match pattern with the origins your extension supports:

```json
{
  "content_scripts": [
    {
      "matches": ["https://example.com/*"],
      "js": ["webmcp-polyfill.js"],
      "world": "MAIN",
      "run_at": "document_start"
    }
  ]
}
```

The bundle is self-contained. It needs no web-accessible resources, network requests, MCP server, or extension-specific runtime. Keep top-frame-only injection for the initial document-local implementation.

Use host match patterns without a port; enforce an exact origin separately where your extension needs that restriction.

The page still needs the browser prerequisites described in the README, including an origin-keyed agent cluster. Injecting a script cannot supply a missing `Origin-Agent-Cluster` response header or bypass the page's Permissions Policy.

## Discover and execute from the extension

A Chromium extension service worker or Firefox background script can use `chrome.scripting.executeScript` in the MAIN world. The browser carries the result back; there is no need to create a page-message request protocol. The extension needs the `scripting` permission and access to the target page through a host permission or `activeTab`.

```js
const [{ result: tools }] = await chrome.scripting.executeScript({
  target: { tabId },
  world: "MAIN",
  func: async () => {
    const tools = await document.modelContext.getTools();
    // WindowProxy cannot cross the extension serialization boundary.
    return tools.map(({ window, ...metadata }) => metadata);
  },
});

const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId },
  world: "MAIN",
  args: [toolName, inputObject],
  func: async (name, input) => {
    const context = document.modelContext;
    const tool = (await context.getTools()).find((tool) => tool.name === name);
    if (!tool) throw new Error("Tool is no longer available");
    return context.executeTool(tool, input);
  },
});
```

`tabId`, `toolName`, and `inputObject` come from your extension's own UI or agent. Match the target document as well as the tab when retaining a selection across navigation. Re-check availability and permissions before acting. This example assumes the object-input execution API; older native Chrome implementations are outside this package's compatibility scope.

`AbortSignal` cannot cross `executeScript` arguments, so the example above has no cancellation. The polyfill supports execution signals; to use them, create the `AbortController` inside the MAIN-world function and drive it from your extension's own cancellation path.

## Observe changes with DOM events

For live discovery, a MAIN-world content script can listen to the existing `toolchange` event. If your isolated content script needs a notification, forward a payload-free DOM event on the shared document:

```js
// MAIN world: load after webmcp-polyfill.js.
document.modelContext.addEventListener("toolchange", () => {
  document.dispatchEvent(new Event("my-extension:webmcp-tools-changed"));
});

// ISOLATED world: use your existing refresh and extension messaging code.
document.addEventListener("my-extension:webmcp-tools-changed", () => {
  // Ask the extension to refresh its tool list using the discovery call above.
});
```

Fetch the initial list after your listener is installed. Notifications are hints: page scripts can forge or suppress them. They must never authorize tool execution or privileged extension actions. Treat discovered metadata and results as page-controlled data too.

Chrome documents [execution worlds and content-script injection](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) and [the scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting). MAIN-world code is visible to and affected by the page; DOM events are communication, not an authentication boundary.

The integration tests run these examples in both Chromium and Firefox. Firefox also exposes the Promise-based `browser.scripting` namespace. See [Mozilla's scripting API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript) for browser-specific result and error handling.
