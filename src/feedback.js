// `ginmi feedback`: a Markdown handoff of the user's decisions and threads, with instructions for an agent.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, readManifest } from "./workspace.js";

const readJsonl = (file) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const textOf = (content) =>
  typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("");
const quote = (s) => s.trim().replace(/\n/g, "\n> ");

// One entry per exchange: the user's message and the final answer text of that turn.
function exchanges(sessionFile, firstQuestion) {
  const out = [];
  for (const e of readJsonl(sessionFile)) {
    if (e.type !== "message") continue;
    const msg = e.message;
    if (msg.role === "user") out.push({ question: out.length ? textOf(msg.content) : firstQuestion, answer: "" });
    else if (msg.role === "assistant" && out.length) {
      const text = textOf(msg.content);
      if (text) out.at(-1).answer = text;
    }
  }
  return out;
}

export function feedbackHandoff(ws) {
  const m = readManifest(ws);
  const p = paths(ws);
  const review = readFileSync(join(p.root, m.review), "utf8");
  const items = [...review.matchAll(/^###\s+(\d+[a-z]?)\.\s+(.*)$/gm)].map(([, id, title]) => ({ id, title }));
  const decisions = existsSync(p.decisions) ? JSON.parse(readFileSync(p.decisions, "utf8")) : {};
  const threads = existsSync(p.threads)
    ? readdirSync(p.threads)
        .filter((f) => f.endsWith(".anchor.json"))
        .map((f) => JSON.parse(readFileSync(join(p.threads, f), "utf8")))
        .sort((a, b) => a.created.localeCompare(b.created))
    : [];

  const branch = m.source_branch ? `\`${m.source_branch}\`` : "the MR's source branch";
  const lines = [
    `# Review feedback: ${m.title ?? p.id}`,
    "",
    "## Instructions for the agent",
    "",
    `The user reviewed ${m.url ?? "this change"} in ginmi and left the decisions and threads below.`,
    "Work on that feedback:",
    "",
    `1. Work in a checkout of ${branch}.`,
    "   If the user asked for a new worktree, create one for that branch (`git worktree add`) and work there; otherwise use the current directory.",
    "   Do not switch branches, reset, or stash in an existing checkout without asking.",
    `2. The review was pinned to head \`${m.head_sha}\` (merge base \`${m.base_sha}\`).`,
    "   If the branch has moved since, say so and check whether the feedback still applies before editing.",
    "3. Treat the user's questions and statements as requirements and preferences.",
    "   Treat the answers as leads from another agent: verify them in the code before relying on them.",
    "4. Accepted items: fix them. Deferred items: list them, do not change them. Dismissed items: leave them alone.",
    "   Items without a decision: ask the user, unless their threads make the intent clear.",
    "5. Before editing, propose a short plan per item and wait for the user's go-ahead.",
    "6. Do not push, open MRs, or post review comments without explicit permission.",
    "   If the user does not own this MR, draft review comments in a file for them instead of changing code.",
    "",
    `Full findings: \`${join(p.root, m.review)}\`.`,
    `Reference clone at the reviewed head (read-only, do not edit): \`${p.clone}\`.`,
    "",
  ];

  const renderThreads = (ts) => {
    for (const t of ts) {
      const where =
        t.kind === "diagram" ? `On diagram node "${t.label}":` : t.kind === "general" ? "On the review as a whole:" : `On the text:\n> ${quote(t.quote)}`;
      lines.push(`#### Thread ${t.thread}`, "", where, "");
      for (const x of exchanges(join(p.threads, `${t.thread}.jsonl`), t.question)) {
        lines.push("**User:**", "", `> ${quote(x.question)}`, "", "**Answer:**", "", x.answer.trim() || "(no answer)", "");
      }
    }
  };

  lines.push("## Items", "");
  for (const item of items) {
    const d = decisions[item.id] ?? {};
    const notes = [...(d.notes ?? []).map((n) => n.text), ...(d.note ? [d.note] : [])];
    lines.push(`### ${item.id}. ${item.title}`, "", `Decision: ${d.decision ?? "none"}`, "");
    if (notes.length) lines.push("User notes:", "", ...notes.map((n) => `- ${n}`), "");
    const ts = threads.filter((t) => t.item === item.id);
    if (ts.length) renderThreads(ts);
    else lines.push("No threads.", "");
  }
  const general = threads.filter((t) => !items.some((i) => i.id === t.item));
  if (general.length) {
    lines.push("## Other threads", "");
    renderThreads(general);
  }
  return lines.join("\n");
}
