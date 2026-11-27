// Workspace preparation: manifest, clone at the pinned head, and the context pack.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const PACK_SCHEMA = 1;
const MAX_DIFF_CHARS = 150_000;

const git = (cwd, args, opts = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

const expandHome = (p) => (p && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function readManifest(ws) {
  const m = JSON.parse(readFileSync(join(ws, "review.json"), "utf8"));
  for (const key of ["schema", "base_sha", "head_sha", "review"]) {
    if (m[key] === undefined) throw new Error(`review.json is missing "${key}"`);
  }
  if (m.schema !== 1) throw new Error(`Unsupported review.json schema ${m.schema}`);
  if (!m.repo && !m.remote) throw new Error(`review.json needs "repo" or "remote"`);
  m.repo = expandHome(m.repo);
  return m;
}

export function paths(ws) {
  const root = realpathSync(ws);
  return {
    root,
    id: basename(root),
    clone: join(root, "repo"),
    state: join(root, "ginmi"),
    threads: join(root, "ginmi", "threads"),
    pack: join(root, "ginmi", "pack.md"),
    base: join(root, "ginmi", "base.jsonl"),
    summaries: join(root, "ginmi", "summaries.jsonl"),
    decisions: join(root, "ginmi", "decisions.json"),
    todos: join(root, "ginmi", "todos.json"),
    events: join(root, "ginmi", "events.jsonl"),
  };
}

const hasCommit = (cwd, sha) => {
  try {
    git(cwd, ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Clone at head_sha without touching the user's checkout.
function ensureClone(m, p, log) {
  if (!existsSync(p.clone)) {
    if (m.repo) {
      log(`Cloning ${m.repo} (shared objects) into ${p.clone}`);
      git(p.root, ["clone", "--quiet", "--shared", "--no-checkout", m.repo, p.clone]);
    } else {
      log(`Cloning ${m.remote} into ${p.clone}`);
      git(p.root, ["clone", "--quiet", "--no-checkout", m.remote, p.clone]);
    }
  }
  const missing = [m.base_sha, m.head_sha].filter((sha) => !hasCommit(p.clone, sha));
  if (missing.length) {
    const remote = m.remote ?? git(m.repo, ["remote", "get-url", "origin"]).trim();
    const refs = m.fetch_refs ?? [];
    log(`Fetching ${refs.join(", ") || "all refs"} from ${remote}`);
    git(p.clone, ["fetch", "--quiet", remote, ...refs]);
    for (const sha of missing) {
      if (!hasCommit(p.clone, sha)) throw new Error(`Commit ${sha} not found after fetching ${refs.join(", ")}`);
    }
  }
  // A --no-checkout clone can already have HEAD at head_sha (when the local repo is on that commit) but an empty index.
  const current = git(p.clone, ["rev-parse", "HEAD"]).trim();
  let indexMatchesHead = true;
  try {
    git(p.clone, ["diff", "--cached", "--quiet", "HEAD"], { stdio: "ignore" });
  } catch {
    indexMatchesHead = false;
  }
  if (current !== m.head_sha || !indexMatchesHead) git(p.clone, ["checkout", "--quiet", "--force", "--detach", m.head_sha]);
}

const readOptional = (ws, rel) => (rel && existsSync(join(ws, rel)) ? readFileSync(join(ws, rel), "utf8") : null);

function buildPack(m, p) {
  const review = readFileSync(join(p.root, m.review), "utf8");
  const metadata = readOptional(p.root, m.metadata);
  const readingMap = readOptional(p.root, m.reading_map);
  const range = `${m.base_sha}...${m.head_sha}`;
  const stat = git(p.clone, ["diff", "--stat=200", range]);
  const diff = git(p.clone, ["diff", range]);
  const diffSection =
    diff.length <= MAX_DIFF_CHARS
      ? "```diff\n" + diff + "```"
      : `The full diff is ${diff.length} characters, too large to include.\nRead it per file with \`git diff ${range} -- <path>\`.`;

  return `# ginmi context pack

You answer a human reviewer's clarifying questions about the code review below.
The reviewer reads the review in a browser, selects a sentence or diagram node, and asks a question about it.
Each question arrives with its anchor: the item and the exact selected text or diagram node.

Rules:
- You are read-only. File writes are blocked by a sandbox; do not try to edit the review, the repository, or anything else.
- Your working directory is a clone of the repository checked out at the reviewed head commit, so line numbers in the review match the files on disk.
- Investigate with read, rg, git log, git show, git blame, and \`git diff ${range}\` when the review and diff below are not enough.
- Answer the question directly first, then give supporting evidence with \`path:line\` references relative to the repository root.
- Be concise: a short paragraph or a few bullets unless more is asked for.
- Explain jargon and abbreviations inline the first time you use them.
- Say clearly when something is uncertain, and distinguish what you verified from what you infer.
- If the question shows the review is wrong or unclear, say so plainly; the reviewer uses your answers to judge the review itself.
- Earlier threads may appear as "Earlier thread" messages; use them for context, but answer only the current question.

## Review identity

- Title: ${m.title ?? "(none)"}
- URL: ${m.url ?? "(none)"}
- Base (merge base): ${m.base_sha}
- Head: ${m.head_sha}
- Repository clone (cwd): ${p.clone}

## Review

${review}
${metadata ? `\n## Review metadata\n\n${metadata}\n` : ""}
## Changed files

\`\`\`
${stat}\`\`\`

## Diff

${diffSection}
${readingMap ? `\n## Reading map\n\nFiles and line ranges the reviewer consulted:\n\n\`\`\`json\n${readingMap}\n\`\`\`\n` : ""}`;
}

export function prepareWorkspace(ws, log = console.error) {
  const m = readManifest(ws);
  const p = paths(ws);
  mkdirSync(p.threads, { recursive: true });
  ensureClone(m, p, log);
  if (!existsSync(p.pack)) writeFileSync(p.pack, buildPack(m, p));
  return { manifest: m, paths: p };
}
