// serve-fixtures.mjs — minimal static server for the "other page" fixtures.
//
// Serves e2e/fixtures over HTTP so the embedded overlay runs on a real origin
// (localStorage + CORS behave exactly as on a third-party host). The placeholder
// __API_URL__ in HTML fixtures is replaced with the running API URL.

import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "..", "fixtures");
const port = Number(process.env.FIXTURE_PORT || 18096);
const apiUrl = process.env.E2E_API_URL || "http://localhost:18095";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const rel = url.pathname === "/" ? "/host.html" : url.pathname;
    const file = path.join(dir, path.normalize(decodeURIComponent(rel)));
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    let body = readFileSync(file);
    if (file.endsWith(".html")) {
      body = Buffer.from(body.toString("utf8").replaceAll("__API_URL__", apiUrl));
    }
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  })
  .listen(port, () => {
    console.log(`fixtures: http://localhost:${port} -> ${dir}`);
  });
