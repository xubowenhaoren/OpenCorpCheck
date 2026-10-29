#!/usr/bin/env node
// Minimal local preview server for the UI prototype.
// The prototype file is authored for the Artifact wrapper (no doctype/html/head),
// so this server adds the document skeleton before serving it.
//
// Usage: node scripts/preview-ui.mjs  →  http://127.0.0.1:4173
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "prototypes", "ui", "index.html");
const host = process.env.OCC_UI_HOST ?? "127.0.0.1";
const port = Number(process.env.OCC_UI_PORT ?? 4173);

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
  if (pathname !== "/" && pathname !== "/index.html") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  try {
    let html = await readFile(file, "utf8");
    if (!/name="viewport"/.test(html)) {
      html = html.replace(
        '<meta name="claude:viewport-fit-sides" content="cover">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
          '<meta name="claude:viewport-fit-sides" content="cover">',
      );
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(`<!doctype html>\n${html}`);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`failed to read prototype: ${error.message}`);
  }
});

server.listen(port, host, () => {
  console.log(`OpenCorpCheck UI prototype: http://${host}:${port}`);
  console.log(`Source: ${file}`);
});
