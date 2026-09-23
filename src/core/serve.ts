import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

// Tiny static file server for local fixtures (and T20 QA later): no
// directory listing, no caching headers, "/" maps to "index.html".
export async function serveDir(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = resolve(dir);

  const server = createServer((req, res) => {
    void (async () => {
      let reqPath: string;
      try {
        reqPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      } catch {
        res.writeHead(400).end(); // malformed %-escape in the request path
        return;
      }
      const rel = reqPath === "/" ? "/index.html" : reqPath;
      const filePath = resolve(join(root, rel));
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const body = await readFile(filePath);
        res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    // closeAllConnections: browsers hold keep-alive sockets open, which would stall close() until they time out.
    close: () =>
      new Promise<void>((res, rej) => {
        server.close((err) => (err ? rej(err) : res()));
        server.closeAllConnections();
      }),
  };
}
