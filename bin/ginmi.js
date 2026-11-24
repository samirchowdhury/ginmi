#!/usr/bin/env node
// ginmi CLI: open a review workspace in the browser UI, or run the server.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codeVersion, DATA_DIR, PORT, readRegistry, REGISTRY, serve } from "../src/server.js";
import { prepareWorkspace } from "../src/workspace.js";

const BASE = `http://127.0.0.1:${PORT}`;
const USAGE = `Usage:
  ginmi open <workspace> [--browser]   Prepare a review workspace and print its URL
  ginmi serve                          Run the server in the foreground
  ginmi stop                           Stop the background server`;

const health = () =>
  fetch(`${BASE}/api/health`)
    .then((r) => r.json())
    .catch(() => null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopServer() {
  const h = await health();
  if (!h) return false;
  process.kill(h.pid, "SIGTERM");
  while (await health()) await sleep(100);
  return true;
}

// Start the background server, restarting it if it runs older ginmi code.
async function ensureServer() {
  const h = await health();
  if (h?.version === codeVersion()) return;
  if (h) await stopServer();
  mkdirSync(DATA_DIR, { recursive: true });
  const log = openSync(`${DATA_DIR}/server.log`, "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 50; i++) {
    if (await health()) return;
    await sleep(100);
  }
  throw new Error(`ginmi server did not start; see ${DATA_DIR}/server.log`);
}

async function open(ws, browser) {
  const { paths } = prepareWorkspace(ws, (msg) => console.error(msg));
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify({ ...readRegistry(), [paths.id]: paths.root }, null, 2));
  await ensureServer();
  // Loading state creates the runtime, which starts the cache warm-up in the background.
  const r = await fetch(`${BASE}/api/r/${paths.id}/state`);
  if (!r.ok) throw new Error((await r.json()).error);
  const url = `${BASE}/r/${paths.id}/`;
  console.log(url);
  if (browser) spawn("open", [url], { stdio: "ignore" });
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "open" && args[0]) await open(args[0], args.includes("--browser"));
  else if (cmd === "serve") serve();
  else if (cmd === "stop") console.log((await stopServer()) ? "stopped" : "not running");
  else {
    console.error(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`ginmi: ${e.message ?? e}`);
  process.exit(1);
}
