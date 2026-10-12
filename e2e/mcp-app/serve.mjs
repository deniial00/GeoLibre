import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const port = Number(process.env.MCP_APP_E2E_PORT ?? 4186);
const stagedResource = resolve(root, "python/src/geolibre/static/mcp/show-map.html");
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["e2e/mcp-app/host.ts"],
  bundle: true,
  outfile: "host.js",
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  sourcemap: false,
});
const hostBundle = bundled.outputFiles.find((file) => file.path.endsWith(".js"))?.contents;
if (!hostBundle) throw new Error("esbuild did not produce the MCP test host bundle");

const hostDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GeoLibre MCP App host harness</title>
<style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}body{min-height:100vh}#app-container{width:min(100vw,800px);height:480px;max-width:100vw}iframe{display:block}</style>
<script type="module" src="/host.js"></script></head><body><main id="app-container" aria-label="GeoLibre map preview host"></main></body></html>`;

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

const resourceCsp = [
  "default-src 'none'",
  "connect-src 'none'",
  "img-src data: blob:",
  "font-src data: blob:",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' blob:",
  "worker-src blob:",
  "child-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }
  if (url.pathname === "/") {
    send(response, 200, "text/html; charset=utf-8", request.method === "HEAD" ? "" : hostDocument);
    return;
  }
  if (url.pathname === "/host.js") {
    send(
      response,
      200,
      "text/javascript; charset=utf-8",
      request.method === "HEAD" ? "" : hostBundle,
    );
    return;
  }
  if (url.pathname === "/show-map.html") {
    try {
      const html = await readFile(stagedResource);
      send(response, 200, "text/html; charset=utf-8", request.method === "HEAD" ? "" : html, {
        "content-security-policy": resourceCsp,
        "referrer-policy": "no-referrer",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
      });
    } catch {
      send(
        response,
        503,
        "text/plain; charset=utf-8",
        "Built MCP resource is unavailable. Run npm run build:mcp-app first.",
      );
    }
    return;
  }
  send(response, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MCP App test host listening on http://127.0.0.1:${port}`);
});
