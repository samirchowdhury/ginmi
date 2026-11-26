// HTTP server: serves the review page, a JSON API, and server-sent events (SSE) for streaming answers.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "./runtime.js";
import { prepareWorkspace } from "./workspace.js";

export const PORT = Number(process.env.GINMI_PORT ?? 7477);
export const DATA_DIR = join(homedir(), ".local", "share", "ginmi");
export const REGISTRY = join(DATA_DIR, "registry.json");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const VENDOR = {
  "markdown-it.js": "node_modules/markdown-it/dist/markdown-it.min.js",
  "mermaid.js": "node_modules/mermaid/dist/mermaid.min.js",
  "svg-pan-zoom.js": "node_modules/svg-pan-zoom/dist/svg-pan-zoom.min.js",
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// Changes whenever ginmi's own code changes, so `ginmi open` can restart a stale server.
export function codeVersion() {
  const h = createHash("sha256");
  for (const dir of ["src", "public"]) {
    for (const f of readdirSync(join(ROOT, dir)).sort()) h.update(f).update(readFileSync(join(ROOT, dir, f)));
  }
  return h.digest("hex").slice(0, 12);
}

export const readRegistry = () => (existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : {});

const runtimes = new Map();
const RUNNING_VERSION = codeVersion();
function runtime(id) {
  if (!runtimes.has(id)) {
    const ws = readRegistry()[id];
    if (!ws) return null;
    runtimes.set(id, new Runtime(prepareWorkspace(ws)));
  }
  return runtimes.get(id);
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
};

const sendFile = (res, file) => {
  if (!existsSync(file)) return json(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
};

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/health") return json(res, 200, { version: RUNNING_VERSION, pid: process.pid });
  if (url.pathname === "/favicon.ico") return res.writeHead(204).end();
  if (parts[0] === "static" && parts.length === 2) return sendFile(res, join(PUBLIC, normalize(parts[1])));
  if (parts[0] === "vendor" && VENDOR[parts[1]]) return sendFile(res, join(ROOT, VENDOR[parts[1]]));
  if (parts[0] === "r" && parts.length === 2) {
    if (!url.pathname.endsWith("/")) {
      res.writeHead(302, { location: url.pathname + "/" });
      return res.end();
    }
    return sendFile(res, join(PUBLIC, "index.html"));
  }
  if (parts[0] !== "api" || parts[1] !== "r") return json(res, 404, { error: "not found" });

  const rt = runtime(parts[2]);
  if (!rt) return json(res, 404, { error: `Unknown review ${parts[2]}; run \`ginmi open <workspace>\`` });
  const [, , , resource, tid, action] = parts;

  if (req.method === "GET" && resource === "state") return json(res, 200, rt.state());
  if (req.method === "GET" && resource === "worktrees") return json(res, 200, { worktrees: rt.worktrees() });
  if (req.method === "GET" && resource === "events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    res.write(`data: ${JSON.stringify({ type: "base_status", ...rt.base })}\n\n`);
    const unsubscribe = rt.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
    return;
  }
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  const body = await readBody(req);
  if (resource === "threads" && !tid) return json(res, 200, { thread: await rt.createThread(body.anchor, body.question) });
  if (resource === "threads" && action === "messages") {
    await rt.followUp(tid, body.text);
    return json(res, 200, { ok: true });
  }
  if (resource === "threads" && action === "delete") {
    await rt.deleteThread(tid);
    return json(res, 200, { ok: true });
  }
  if (resource === "threads" && action === "abort") {
    await rt.abort(tid);
    return json(res, 200, { ok: true });
  }
  if (resource === "decisions") return json(res, 200, rt.setDecision(body.item, body.patch));
  if (resource === "telemetry") {
    rt.clientTelemetry(body.type, body.data ?? {});
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

export function serve() {
  const server = createServer((req, res) =>
    route(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: String(e.message ?? e) });
    }),
  );
  server.listen(PORT, "127.0.0.1", () => console.error(`ginmi ${RUNNING_VERSION} listening on http://127.0.0.1:${PORT}`));
  const stop = () => {
    for (const rt of runtimes.values()) rt.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
