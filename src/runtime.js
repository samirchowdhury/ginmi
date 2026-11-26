// Per-workspace runtime: pi RPC threads, seeding, digests, decisions, and telemetry.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { PACK_SCHEMA } from "./workspace.js";

const IDLE_KILL_MS = 10 * 60 * 1000;
const DIGEST_MAX_CHARS = 2000;
export const TOOL_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const GLOBAL_EVENTS_DIR = join(homedir(), ".local", "share", "ginmi", "events");

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const textOf = (content) =>
  typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("");
const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …" : s);
const describeAnchor = (a) =>
  a.kind === "diagram" ? `diagram node "${a.label}"` : a.kind === "general" ? "the whole review" : `"${clip(a.quote, 200)}"`;

// One pi RPC subprocess, sandboxed so it cannot write to the workspace or the source repo.
class PiProcess {
  constructor({ sessionFile, cwd, pack, profile, onEvent, onExit }) {
    const args = ["--mode", "rpc", "--session", sessionFile, "--append-system-prompt", pack,
      "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp"];
    if (process.env.GINMI_MODEL) args.push("--model", process.env.GINMI_MODEL);
    this.proc = spawn("sandbox-exec", ["-p", profile, "pi", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.stderr = "";
    this.proc.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "response" && ev.id && this.pending.has(ev.id)) {
        this.pending.get(ev.id)(ev);
        this.pending.delete(ev.id);
      } else onEvent(ev);
    });
    this.proc.on("exit", (code) => {
      for (const resolve of this.pending.values()) resolve({ success: false, error: `pi exited (${code})` });
      this.pending.clear();
      onExit(code, this.stderr);
    });
  }
  send(cmd) {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }
  kill() {
    this.proc.kill();
  }
}

export class Runtime {
  constructor({ manifest, paths }) {
    this.m = manifest;
    this.p = paths;
    this.threads = new Map(); // tid -> { anchor, proc, status, run }
    this.listeners = new Set();
    this.model = null;
    this.profile = this.#sandboxProfile();
    this.files = execFileSync("git", ["ls-files"], { cwd: this.p.clone, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
    mkdirSync(GLOBAL_EVENTS_DIR, { recursive: true });
    for (const f of readdirSync(this.p.threads).filter((f) => f.endsWith(".anchor.json"))) {
      const anchor = JSON.parse(readFileSync(join(this.p.threads, f), "utf8"));
      this.threads.set(anchor.thread, { anchor, proc: null, status: "idle", run: null });
    }
    this.base = { status: this.#systemEntry() ? "ready" : "warming", error: null };
    this.baseReady = this.#ensureBase();
    this.baseReady.then(
      () => (this.base.status = "ready"),
      (e) => {
        this.base = { status: "error", error: String(e.message ?? e) };
        this.#broadcast({ type: "base_status", ...this.base });
      },
    );
  }

  #sandboxProfile() {
    const q = (s) => JSON.stringify(s);
    const rules = [
      "(version 1)",
      "(allow default)",
      `(deny file-write* (subpath ${q(this.p.root)}))`,
      `(allow file-write* (subpath ${q(this.p.threads)}) (literal ${q(this.p.base)}))`,
    ];
    if (this.m.repo && existsSync(this.m.repo)) rules.push(`(deny file-write* (subpath ${q(realpathSync(this.m.repo))}))`);
    return rules.join("");
  }

  #spawn(sessionFile, onEvent, onExit) {
    return new PiProcess({ sessionFile, cwd: this.p.clone, pack: this.p.pack, profile: this.profile, onEvent, onExit });
  }

  #systemEntry() {
    return readJsonl(this.p.base).find((e) => e.type === "message" && e.message.role === "system");
  }

  // Warm-up request: pi persists the system message (needed to seed threads) and warms the prompt cache.
  async #ensureBase() {
    if (this.#systemEntry()) return;
    const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: this.p.clone };
    writeFileSync(this.p.base, JSON.stringify(header) + "\n");
    this.#broadcast({ type: "base_status", status: "warming" });
    await new Promise((resolve, reject) => {
      const proc = this.#spawn(
        this.p.base,
        (ev) => {
          if (ev.type === "message_end" && ev.message.role === "assistant") this.#telemetry("warmup", { usage: ev.message.usage, model: ev.message.model });
          if (ev.type === "agent_settled") proc.kill();
        },
        (code, stderr) => (this.#systemEntry() ? resolve() : reject(new Error(`pi warm-up failed (${code}): ${stderr.trim()}`))),
      );
      proc.send({ type: "prompt", message: "Reply with OK." }).then((r) => {
        if (!r.success) reject(new Error(r.error ?? "warm-up prompt rejected"));
      });
    });
    this.#broadcast({ type: "base_status", status: "ready" });
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #broadcast(ev) {
    for (const fn of this.listeners) fn(ev);
  }

  #telemetry(type, data = {}) {
    const ev = {
      ts: new Date().toISOString(),
      type,
      review_id: this.p.id,
      skill: this.m.producer?.skill ?? null,
      skill_version: this.m.producer?.version ?? null,
      pack_schema: PACK_SCHEMA,
      tool_version: TOOL_VERSION,
      model: data.model ?? this.model,
      ...data,
    };
    const line = JSON.stringify(ev) + "\n";
    appendFileSync(this.p.events, line);
    appendFileSync(join(GLOBAL_EVENTS_DIR, `${this.p.id}.jsonl`), line);
  }

  clientTelemetry(type, data) {
    this.#telemetry(`ui_${type}`, data);
  }

  #sessionFile(tid) {
    return join(this.p.threads, `${tid}.jsonl`);
  }

  // Seed: header, the base system message, then one custom_message per earlier exchange.
  #seed(tid) {
    const now = new Date().toISOString();
    const lines = [{ type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: this.p.clone }];
    const sys = this.#systemEntry();
    lines.push({ ...sys, id: "sys00000", parentId: null });
    let parent = "sys00000";
    readJsonl(this.p.summaries).forEach((d, i) => {
      const id = `dig${String(i).padStart(5, "0")}`;
      const content = `Earlier thread (item ${d.anchor.item}, on ${describeAnchor(d.anchor)}):\nQ: ${d.question}\nA: ${clip(d.answer, DIGEST_MAX_CHARS)}`;
      lines.push({ type: "custom_message", id, parentId: parent, timestamp: now, customType: "ginmi-digest", content, display: false });
      parent = id;
    });
    writeFileSync(this.#sessionFile(tid), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  #ensureProc(tid) {
    const t = this.threads.get(tid);
    if (t.proc) return t.proc;
    t.proc = this.#spawn(
      this.#sessionFile(tid),
      (ev) => this.#onEvent(tid, ev),
      (code, stderr) => {
        t.proc = null;
        if (t.status === "running") {
          t.status = "error";
          this.#broadcast({ type: "thread_status", thread: tid, status: "error", error: `pi exited (${code}): ${stderr.trim().slice(-500)}` });
        }
      },
    );
    return t.proc;
  }

  #onEvent(tid, ev) {
    const t = this.threads.get(tid);
    const run = t.run;
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      if (run && run.ttft === null) run.ttft = Date.now() - run.start;
      this.#broadcast({ type: "delta", thread: tid, delta: ev.assistantMessageEvent.delta });
    } else if (ev.type === "message_start" && ev.message.role === "assistant") {
      this.#broadcast({ type: "assistant_start", thread: tid });
    } else if (ev.type === "tool_execution_start") {
      this.#broadcast({ type: "tool", thread: tid, name: ev.toolName, args: ev.args });
    } else if (ev.type === "message_end" && ev.message.role === "assistant") {
      const u = ev.message.usage ?? {};
      this.model = ev.message.model ?? this.model;
      if (run) {
        for (const k of ["input", "output", "cacheRead", "cacheWrite"]) run.usage[k] += u[k] ?? 0;
        run.requests += 1;
        const text = textOf(ev.message.content);
        if (text) run.answer = text;
      }
      if (ev.message.stopReason === "error") this.#broadcast({ type: "thread_error", thread: tid, error: ev.message.errorMessage ?? "error" });
    } else if (ev.type === "agent_settled") {
      t.status = "idle";
      if (run) this.#finishRun(tid, t, run, ev.aborted);
      t.run = null;
      this.#broadcast({ type: "thread_status", thread: tid, status: "idle" });
      clearTimeout(t.idleTimer);
      t.idleTimer = setTimeout(() => t.proc?.kill(), IDLE_KILL_MS);
    }
  }

  #finishRun(tid, t, run, aborted) {
    const { usage } = run;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    this.#telemetry("answer", {
      thread: tid,
      item: t.anchor.item,
      aborted,
      ttft_ms: run.ttft,
      duration_ms: Date.now() - run.start,
      requests: run.requests,
      usage,
      cache_hit_ratio: prompt ? usage.cacheRead / prompt : null,
    });
    if (!aborted && run.answer) {
      appendFileSync(this.p.summaries, JSON.stringify({ thread: tid, anchor: t.anchor, question: run.question, answer: run.answer }) + "\n");
    }
  }

  async #prompt(tid, message, question) {
    const t = this.threads.get(tid);
    clearTimeout(t.idleTimer);
    t.status = "running";
    t.run = { start: Date.now(), ttft: null, question, answer: "", requests: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    this.#broadcast({ type: "thread_status", thread: tid, status: "running" });
    const r = await this.#ensureProc(tid).send({ type: "prompt", message });
    if (!r.success) {
      t.status = "error";
      t.run = null;
      this.#broadcast({ type: "thread_status", thread: tid, status: "error", error: r.error ?? "prompt rejected" });
    }
  }

  async createThread(anchor, question) {
    await this.baseReady;
    const tid = randomUUID().slice(0, 8);
    const full = { ...anchor, thread: tid, question, created: new Date().toISOString() };
    this.#seed(tid);
    writeFileSync(join(this.p.threads, `${tid}.anchor.json`), JSON.stringify(full, null, 2));
    this.threads.set(tid, { anchor: full, proc: null, status: "idle", run: null });
    this.#broadcast({ type: "thread_created", thread: this.#threadView(tid) });
    this.#telemetry("question", { thread: tid, item: anchor.item, anchor_kind: anchor.kind, quote: anchor.quote ?? anchor.label, question, follow_up: false });
    const where =
      anchor.kind === "diagram"
        ? `Anchor: item ${anchor.item}, diagram node "${anchor.label}" (id ${anchor.node}).`
        : anchor.kind === "general"
          ? "Anchor: the review as a whole."
          : `Anchor: item ${anchor.item}${anchor.itemTitle ? ` ("${anchor.itemTitle}")` : ""}, selected text:\n> ${anchor.quote.replace(/\n/g, "\n> ")}`;
    await this.#prompt(tid, `${where}\n\nQuestion: ${question}`, question);
    return tid;
  }

  async followUp(tid, text) {
    const t = this.threads.get(tid);
    if (!t) throw new Error(`No thread ${tid}`);
    if (t.status === "running") throw new Error("Thread is still answering");
    this.#telemetry("question", { thread: tid, item: t.anchor.item, question: text, follow_up: true });
    await this.#prompt(tid, text, text);
  }

  async abort(tid) {
    await this.threads.get(tid)?.proc?.send({ type: "abort" });
  }

  // Thread transcript from its session file, skipping the seeded prefix.
  #threadView(tid) {
    const t = this.threads.get(tid);
    const messages = [];
    let firstUser = true;
    for (const e of readJsonl(this.#sessionFile(tid))) {
      if (e.type !== "message") continue;
      const msg = e.message;
      if (msg.role === "user") {
        messages.push({ role: "user", text: firstUser ? t.anchor.question : textOf(msg.content) });
        firstUser = false;
      } else if (msg.role === "assistant") {
        const tools = msg.content.filter((c) => c.type === "toolCall").map((c) => ({ name: c.name, args: c.arguments }));
        messages.push({ role: "assistant", text: textOf(msg.content), tools, error: msg.stopReason === "error" ? msg.errorMessage : undefined });
      }
    }
    return { id: tid, anchor: t.anchor, status: t.status, messages };
  }

  decisions() {
    return existsSync(this.p.decisions) ? JSON.parse(readFileSync(this.p.decisions, "utf8")) : {};
  }

  setDecision(item, patch) {
    const all = this.decisions();
    all[item] = { ...all[item], ...patch, updated: new Date().toISOString() };
    writeFileSync(this.p.decisions, JSON.stringify(all, null, 2));
    this.#telemetry("decision", { item, ...patch });
    return all[item];
  }

  state() {
    return {
      id: this.p.id,
      workspace: this.p.root,
      manifest: this.m,
      review: readFileSync(join(this.p.root, this.m.review), "utf8"),
      threads: [...this.threads.keys()].map((tid) => this.#threadView(tid)),
      decisions: this.decisions(),
      files: this.files,
      base: this.base,
    };
  }

  shutdown() {
    for (const t of this.threads.values()) t.proc?.kill();
  }
}
