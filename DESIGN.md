# ginmi design

## Goal

Make reviewing a large feature branch fast: read a decision-first review, ask questions about specific sentences or diagram nodes, and decide.
Reviews are the only use case.
The review is produced elsewhere (currently by the `eng-governance-review` skill); ginmi renders it and answers questions about it.

## Non-goals

- General-purpose HTML artifacts (Lavish covers that).
- Editing the review file from threads.
- Merging threads back into a main conversation.
- Infinite canvas layouts.

## Concepts

- **Workspace**: the review's directory under `/tmp`, holding the review, evidence, and all ginmi state.
- **Manifest** (`review.json`): the contract between the review producer and ginmi.
- **Context pack**: the stable prefix every thread starts from, assembled from the manifest's files.
- **Clone**: a full checkout of the repo at the pinned head SHA that threads navigate with tools.
- **Anchor**: what a question points at, either selected text in an item or a Mermaid node.
- **Thread**: one conversation rooted at an anchor, with its own agent session.
- **Digest**: the anchor, question, and answer of a finished exchange, appended to the context of threads started later.

## Manifest

The producer writes `review.json` in the workspace:

```json
{
  "schema": 1,
  "repo": "~/vpu-main",
  "base_sha": "<full sha>",
  "head_sha": "<full sha>",
  "review": "review.md",
  "metadata": "review-metadata.md",
  "reading_map": "reading-map.json",
  "producer": { "skill": "eng-governance-review", "version": "<git sha>" }
}
```

`reading_map` is optional: the files and line ranges the reviewer consulted, so threads know where to look first.

## Context

Threads get the context pack plus clone, not the producer's harness transcript.
The pack is small, deterministic, and harness-agnostic, and leaves room in the context window for exploration.
The tradeoff is that threads reread code the reviewer already read; the reading map mitigates this.

Pack order, kept identical across threads so the provider's prompt cache can reuse it:

1. Instructions: read-only, review context, how anchors are described.
2. `review.md` and `review-metadata.md`.
3. Full SHAs, refs, and the clone path.
4. `git diff --stat`, plus the full diff if it is under 150,000 characters, otherwise instructions to read it per file. ginmi computes both from the clone.
5. Reading map, if present.

On open, ginmi runs `git clone --shared <repo> <workspace>/repo` and checks out `head_sha`.
`--shared` reuses the source repo's object storage and does not touch the user's checkout, unlike `git worktree add`.
Threads run with the clone as their working directory, so the review's line numbers match the files on disk.

## Threads

A new thread's context is:

```
context pack + s1 + s2 + ... + s(n-1) + anchor + question
```

`s1 ... s(n-1)` are digests of earlier exchanges, appended in order and never rewritten, so each new thread reuses the previous thread's cached prefix.
A digest is the anchor, the question, and the final answer (clipped to 2,000 characters), recorded when an answer finishes.
Digests are verbatim rather than model-written summaries: they cost no extra request, are available instantly, and a follow-up in an existing thread simply appends another digest.
Existing threads are never refreshed with later digests.

Threads run in parallel, each in its own agent session, so questions are answered immediately instead of queueing behind one conversation.

### Read-only enforcement

Threads keep the same tool definitions as every other thread.
Each pi process runs under macOS `sandbox-exec` with a profile that denies writes to the workspace (except ginmi's thread session files) and to the user's local clone.
This blocks writes from every tool, including `bash`, without parsing commands.
Removing tools changes the provider request and loses prompt-cache reuse entirely (verified: `--tools read,bash` dropped cache reads from 7,401 tokens to 0).
The read-only rule is also stated in the pack instructions, not per thread.

Because the review file never changes, anchors never move.

## Prompt caching

Every thread shares the pack prefix, so its first turn reads the pack from cache.
Later turns in a thread reuse that thread's earlier messages too.
To keep cache hits:

- Keep the model, thinking level, tools, and system prompt identical across threads.
- Put the anchor and question in the user message, never in the system prompt.
- Warm the cache when the page opens, so concurrent first questions don't each pay for a cache write.
- Keep the cache warm across idle gaps (pi's `cacheWarming: "idle"`, or a periodic warm request).

## Harness interface

ginmi talks to an agent harness through three operations:

```
snapshot(pack) -> contextRef
fork(contextRef, digests) -> thread
send(thread, message) -> stream of events
```

First implementation: pi in RPC mode (`pi --mode rpc`), one subprocess per thread.

### Seeding a pi thread

Verified against pi 1.4.0 with `github-copilot` / `claude-opus-5.5`:

- The pack goes in the system prompt via `--append-system-prompt <workspace>/ginmi/pack.md`.
- Summaries go in a seeded session file as `custom_message` entries, opened with `--session <file>`.
  Pi loads them into context without an LLM call.
- The session file must start with a `system` message entry, then the digests.
  Otherwise pi appends its system message after the digests, the prefix differs between threads, and only about 1,200 tokens (the tool definitions) are cached.
- With the system message first, a second thread read 7,401 tokens from cache and wrote 149, costing about 13× less than an uncached start.
- ginmi gets the system message once by running a warm-up request against an empty session with the same flags, which also warms the cache.
  If a pi upgrade changes the system prompt, pi appends a patch system message, costing one cache miss rather than breaking.
- Use `--no-extensions --no-skills --no-context-files --no-prompt-templates --no-mcp` so the prefix doesn't depend on the user's pi setup.
Other candidates later: Claude Code (`claude -p --resume <id> --fork-session`), Codex (`codex exec resume`), or a small built-in agent loop over a provider API.

## Page

A normal scrolling page with a fixed template, not per-review generated HTML.

- Summary block: one line per item, linking to the item.
- Each item: title, then **Decide**, **Scenario**, and **Fix** lines, with details collapsed below.
- Source references link to GitLab at the pinned head SHA.
- Decision buttons per item (accept / dismiss / defer), stored in the workspace.
- Each anchored passage gets a 💬 bubble; clicking it (or the highlighted text) opens the thread in a popover beside the passage, sized to the viewport, with streaming answers and a pinned reply box. The review text never reflows.
- Mermaid diagrams with zoom and pan (`svg-pan-zoom`); clicking a node starts a thread anchored to that node ID and label.

## Persistence

All state lives in the workspace, so `ginmi open <workspace>` restores the page:

```
<workspace>/
  review.json
  review.md
  review-metadata.md
  reading-map.json
  repo/                  # clone at head_sha
  ginmi/
    pack.md              # assembled context pack
    base.jsonl           # warm-up session holding the system message
    summaries.jsonl      # exchange digests in order
    decisions.json
    threads/<id>.jsonl   # harness session per thread
    threads/<id>.anchor.json
    events.jsonl         # telemetry
```

## Telemetry

The review experience depends on both the producer skill and ginmi.
Every event records `review_id`, `skill_version`, `pack_schema`, `tool_version`, `model`, and `ts`, so changes can be attributed.
Events go to `<workspace>/ginmi/events.jsonl` and are copied to `~/.local/share/ginmi/events/`, since `/tmp` is wiped.
Local only.

Initial events:

- Time to decision per item, and decision changes.
- Questions with their anchors (the main signal about what the review failed to explain).
- Answer latency: time to first token and total time.
- Cache-hit ratio per request.

Later: per-item reading time and detail expansion, source-link clicks, diagram interactions, end-of-review rating and note, and whether a finding became an MR comment or code change.
`ginmi report` summarizes across reviews, grouped by skill and tool version.

## Producer-side changes (`eng-governance-review`)

- Write `review.json`.
- Record the source repo path.
- Optionally write `reading-map.json`.
- Adopt the decision-first item format (summary, then Decide / Scenario / Fix, then details).

## Open questions

- Linux support: the sandbox uses macOS `sandbox-exec`.
- How to handle diffs too large for the pack.

## First milestone

1. `ginmi open <workspace>`: read the manifest, make the clone, assemble the pack, serve the page.
2. Render a review in the fixed template.
3. Text-selection anchors starting pi RPC threads, with streaming answers in the margin.
4. Exchange digests appended for later threads.
5. Minimal telemetry: questions, anchors, latency, decisions.

Mermaid interaction, GitLab links, and `ginmi report` come after.
