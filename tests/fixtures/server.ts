import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const appHtml = `<!doctype html>
<meta charset="utf-8">
<title>WebMCP counter</title>
<h1>Counter</h1>
<output id="count">0</output>
<label>Amount <input id="amount" type="number" value="2"></label>
<button id="register">Register</button>
<button id="unregister">Unregister</button>
<button id="execute">Execute on page</button>
<output id="status">loading</output>
<output id="result"></output>
<script src="/auto.js"></script>
<script type="module" src="/app.js"></script>`;

const startupHtml = `<!doctype html>
<meta charset="utf-8">
<title>WebMCP startup</title>
<script src="/auto.js"></script>
<script>
  (async () => {
    const context = document.modelContext;
    await context.registerTool({ name: "startup", description: "Startup", execute: () => "startup" });
    const tools = await context.getTools();
    document.documentElement.dataset.tools = tools.map((tool) => tool.name).join(",");
  })();
</script>`;

// Discovery starts before installation's peer announcements can receive replies.
const startupDiscoveryHtml = `<!doctype html>
<meta charset="utf-8">
<title>WebMCP startup discovery</title>
<script src="/auto.js"></script>
<script>
  document.modelContext.getTools().then((tools) => {
    document.documentElement.dataset.tools = tools.map((tool) => tool.name).join(",");
  });
</script>`;

const blankHtml = "<!doctype html><title>WebMCP test</title>";
const frameHtml = '<!doctype html><title>WebMCP frame</title><script src="/auto.js"></script>';

const pages: Record<string, string> = {
  "/": blankHtml,
  "/health": blankHtml,
  "/no-cluster": blankHtml,
  "/app": appHtml,
  "/frame": frameHtml,
  "/startup": startupHtml,
  "/startup-discovery": startupDiscoveryHtml,
};

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  response.setHeader("Origin-Agent-Cluster", path === "/no-cluster" ? "?0" : "?1");
  response.setHeader("Cache-Control", "no-store");
  const page = pages[path];

  try {
    if (path === "/auto.js" || path === "/app.js") {
      const scriptPath = path === "/auto.js" ? "../../dist/polyfill.js" : "./app.js";
      const source = await readFile(new URL(scriptPath, import.meta.url));
      response.setHeader("Content-Type", "text/javascript");
      response.end(source);
    } else if (page) {
      response.setHeader("Content-Type", "text/html");
      response.end(page);
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
}).listen(8793, "127.0.0.1");
