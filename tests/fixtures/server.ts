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

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  response.setHeader("Origin-Agent-Cluster", path === "/no-cluster" ? "?0" : "?1");
  response.setHeader("Cache-Control", "no-store");

  try {
    if (path === "/auto.js" || path === "/app.js") {
      const scriptPath = path === "/auto.js" ? "../../dist/polyfill.js" : "./app.js";
      const source = await readFile(new URL(scriptPath, import.meta.url));
      response.setHeader("Content-Type", "text/javascript");
      response.end(source);
    } else if (["/", "/health", "/no-cluster"].includes(path)) {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>WebMCP test</title>");
    } else if (path === "/app") {
      response.setHeader("Content-Type", "text/html");
      response.end(appHtml);
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
}).listen(8793, "127.0.0.1");
