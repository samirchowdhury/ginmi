// ginmi page: render the review, anchor questions to text or diagram nodes, and stream thread answers.
/* global markdownit, mermaid, svgPanZoom */

const id = location.pathname.split("/").filter(Boolean)[1];
const api = (path) => `/api/r/${id}/${path}`;
const post = (path, body) =>
  fetch(api(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    return data;
  });
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...children.filter((c) => c !== null && c !== undefined));
  return e;
};

const openedAt = Date.now();
const telemetry = (type, data = {}) => post("telemetry", { type, data: { ...data, ms_since_open: Date.now() - openedAt } }).catch(() => {});

let state;
const threads = new Map(); // id -> thread view
const items = new Map(); // item id -> section element
let activeThread = null;
// A thread opens in a popover beside the passage it anchors to.
let openGroup = []; // ids of the threads shown in the popover (all anchored to one passage)
let openAnchorEl = null; // element the popover lines up with
let draft = null; // a question being written: { anchor, anchorEl, range }

// ---------- Markdown ----------

const md = markdownit({ html: false, linkify: true });
// User messages keep single line breaks, as typed.
const mdUser = markdownit({ html: false, linkify: true, breaks: true });
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  if (t.info.trim() === "mermaid") return `<div class="mermaid-wrap"><pre class="mermaid">${md.utils.escapeHtml(t.content)}</pre></div>`;
  return defaultFence(tokens, idx, opts, env, self);
};

const SOURCE_REF = /^([\w@.+-]+(?:\/[\w@.+-]+)*):(\d+)(?:-(\d+))?/;
let fileSet = null;
// Resolve a referenced path to a repo file: exact match, else a unique suffix match.
function resolvePath(path) {
  fileSet ??= new Set(state.files);
  if (fileSet.has(path)) return path;
  const matches = state.files.filter((f) => f.endsWith(`/${path}`));
  return matches.length === 1 ? matches[0] : null;
}
function linkSources(root, item) {
  const web = state.manifest.web_url;
  if (!web) return;
  for (const code of root.querySelectorAll("code")) {
    if (code.closest("pre, a")) continue;
    const m = code.textContent.match(SOURCE_REF);
    if (!m) continue;
    const [, ref, a, b] = m;
    const path = resolvePath(ref);
    if (!path) continue;
    const href = `${web}/-/blob/${state.manifest.head_sha}/${path}#L${a}${b ? `-${b}` : ""}`;
    const link = el("a", { href, target: "_blank", rel: "noopener", onclick: () => telemetry("source_link", { item, path }) });
    code.replaceWith(link);
    link.append(code);
  }
}

// ---------- Review rendering ----------

const ITEM_HEADING = /^(\d+[a-z]?)\.\s+(.*)$/;

function renderReview() {
  const root = $("#review");
  root.innerHTML = md.render(state.review);

  for (const h2 of root.querySelectorAll("h2")) {
    const t = h2.textContent.toLowerCase();
    if (t.startsWith("high")) h2.classList.add("high");
    if (t.startsWith("should")) h2.classList.add("should");
    if (t.startsWith("summary")) {
      const list = h2.nextElementSibling;
      if (list?.tagName === "OL") {
        list.classList.add("summary");
        const start = Number(list.getAttribute("start") ?? 1);
        [...list.children].forEach((li, i) => {
          li.dataset.item = String(start + i);
          li.addEventListener("click", (e) => {
            if (window.getSelection().isCollapsed) items.get(li.dataset.item)?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        });
      }
    }
  }

  // Wrap each "### N. Title" heading and its content into an item section.
  for (const h3 of [...root.querySelectorAll("h3")]) {
    const m = h3.textContent.trim().match(ITEM_HEADING);
    if (!m) continue;
    const [, item, title] = m;
    const section = el("section", { class: "item", id: `item-${item}`, "data-item": item, "data-title": title });
    h3.before(section);
    const content = [];
    for (let n = h3.nextSibling; n && !/^H[1-3]$/.test(n.tagName ?? ""); n = n.nextSibling) content.push(n);
    section.append(h3, ...content);

    const hr = [...section.children].find((c) => c.tagName === "HR");
    const opener = [...section.children].find((c) => c.tagName === "UL");
    if (opener && (!hr || opener.compareDocumentPosition(hr) & Node.DOCUMENT_POSITION_FOLLOWING)) opener.classList.add("opener");
    if (hr) {
      const details = el("details", {}, el("summary", {}, "Details"));
      const rest = [];
      for (let n = hr.nextSibling; n; n = n.nextSibling) rest.push(n);
      details.append(...rest);
      details.addEventListener("toggle", () => telemetry("details_toggle", { item, open: details.open }));
      hr.replaceWith(decisionBar(item), details);
    } else section.append(decisionBar(item));
    h3.append(el("span", { class: "badge", onclick: () => focusItemThreads(item) }));
    linkSources(section, item);
    items.set(item, section);
  }
  linkSources(root, "general");
  applyDecisions();
}

// Mermaid renders node ids like "mermaid-<random>-flowchart-ML-0"; keep only the stable "ML".
const mermaidNodeId = (node) => node.id.match(/flowchart-(.+)-\d+$/)?.[1] ?? node.id;

async function renderDiagrams() {
  const nodes = [...document.querySelectorAll("pre.mermaid")];
  if (!nodes.length) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
  await mermaid.run({ nodes });
  document.querySelectorAll(".mermaid-wrap").forEach((wrap, i) => {
    const svg = wrap.querySelector("svg");
    if (!svg) return;
    svg.removeAttribute("style");
    const pz = svgPanZoom(svg, { controlIconsEnabled: true, zoomScaleSensitivity: 0.3, minZoom: 0.3, maxZoom: 12 });
    wrap.append(el("p", { class: "hint" }, "Scroll to zoom, drag to pan, click a node to ask about it."));
    // Diagrams inside closed <details> render at zero size; refit when they become visible.
    wrap.closest("details")?.addEventListener("toggle", (e) => {
      if (!e.target.open) return;
      pz.resize();
      pz.fit();
      pz.center();
    });
    let down = null;
    svg.addEventListener("mousedown", (e) => (down = [e.clientX, e.clientY]));
    svg.addEventListener("wheel", () => telemetry("diagram_zoom", { diagram: i, zoom: pz.getZoom() }), { passive: true, once: true });
    for (const node of svg.querySelectorAll("g.node")) {
      node.addEventListener("click", (e) => {
        if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
        const item = wrap.closest(".item")?.dataset.item ?? "general";
        const nodeId = mermaidNodeId(node);
        const label = node.textContent.trim();
        openDraft({ kind: "diagram", item, itemTitle: wrap.closest(".item")?.dataset.title, diagram: i, node: nodeId, label }, wrap);
      });
    }
  });
  markDiagramAnchors();
}

// ---------- Decisions ----------

function decisionBar(item) {
  const bar = el("div", { class: "decision", "data-item": item });
  const choose = (field, value) => async () => {
    const current = state.decisions[item]?.[field];
    const patch = { [field]: current === value ? null : value, ms_since_open: Date.now() - openedAt };
    state.decisions[item] = await post("decisions", { item, patch });
    applyDecisions();
  };
  for (const [value, label] of [["accept", "Accept"], ["dismiss", "Dismiss"], ["defer", "Defer"]]) {
    bar.append(el("button", { type: "button", "data-field": "decision", "data-value": value, onclick: choose("decision", value) }, label));
  }
  return bar;
}

function applyDecisions() {
  for (const bar of document.querySelectorAll(".decision")) {
    const d = state.decisions[bar.dataset.item] ?? {};
    for (const b of bar.querySelectorAll("button")) b.classList.toggle("on", d[b.dataset.field] === b.dataset.value);
    const section = items.get(bar.dataset.item);
    for (const v of ["accept", "dismiss", "defer"]) section?.classList.toggle(`decided-${v}`, d.decision === v);
  }
  const decided = [...items.keys()].filter((i) => state.decisions[i]?.decision).length;
  $("#progress").textContent = items.size ? `${decided}/${items.size} decided` : "";
}

// ---------- Anchors and highlights ----------

// Find quote inside root, ignoring whitespace differences between the selection and the DOM text.
function findRange(root, quote) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest(".decision, .badge, .bubble, svg, .mermaid-wrap") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let norm = "";
  const map = [];
  let lastSpace = true;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (let i = 0; i < n.data.length; i++) {
      const space = /\s/.test(n.data[i]);
      if (space && lastSpace) continue;
      norm += space ? " " : n.data[i];
      map.push([n, i]);
      lastSpace = space;
    }
  }
  const q = quote.replace(/\s+/g, " ").trim();
  const at = norm.indexOf(q);
  if (at < 0 || !q) return null;
  const [sn, so] = map[at];
  const [en, eo] = map[at + q.length - 1];
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo + 1);
  return range;
}

function anchorRange(t) {
  if (t.anchor.kind !== "text") return null;
  const root = items.get(t.anchor.item) ?? $("#review");
  return findRange(root, t.anchor.quote);
}

function refreshHighlights() {
  if (!window.CSS?.highlights) return;
  const ranges = [...threads.values()].map(anchorRange).filter(Boolean);
  CSS.highlights.set("ginmi", new Highlight(...ranges));
  const active = draft?.range ?? (activeThread && anchorRange(threads.get(activeThread)));
  if (active) CSS.highlights.set("ginmi-active", new Highlight(active));
  else CSS.highlights.delete("ginmi-active");
  for (const [item, section] of items) {
    const n = [...threads.values()].filter((t) => t.anchor.item === item).length;
    section.querySelector(".badge").textContent = n ? `💬 ${n}` : "";
  }
  markDiagramAnchors();
}

function markDiagramAnchors() {
  const anchored = new Set([...threads.values()].filter((t) => t.anchor.kind === "diagram").map((t) => `${t.anchor.diagram}:${t.anchor.node}`));
  document.querySelectorAll(".mermaid-wrap").forEach((wrap, i) => {
    for (const node of wrap.querySelectorAll("g.node")) {
      const nodeId = mermaidNodeId(node);
      node.classList.toggle("anchored", anchored.has(`${i}:${nodeId}`));
    }
  });
}

function setActive(tid) {
  activeThread = tid;
  for (const card of document.querySelectorAll(".thread")) card.classList.toggle("active", card.dataset.thread === tid);
  refreshHighlights();
}

function focusItemThreads(item) {
  const ofItem = [...threads.values()].filter((t) => t.anchor.item === item);
  if (!ofItem.length) return;
  const details = anchorBlock(ofItem[0])?.closest("details");
  if (details) details.open = true;
  openGroup = [ofItem[0].id];
  layoutThreads();
  bringAnchorUp();
}

// ---------- Thread placement ----------

// The block element a thread belongs under: the paragraph or list item holding its quote, or its diagram.
function anchorBlock(t) {
  if (t.anchor.kind === "general") return null;
  if (t.anchor.kind === "diagram") return document.querySelectorAll(".mermaid-wrap")[t.anchor.diagram] ?? items.get(t.anchor.item)?.querySelector("h3");
  const range = anchorRange(t);
  const start = range && (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer);
  return start?.closest("li, p, h1, h2, h3, h4, pre, blockquote, td, th") ?? items.get(t.anchor.item)?.querySelector("h3") ?? null;
}

const createdOrder = (a, b) => itemOrder(a.anchor.item) - itemOrder(b.anchor.item) || String(a.anchor.created).localeCompare(String(b.anchor.created));

function toggleThreads(ids) {
  const open = ids.some((tid) => openGroup.includes(tid));
  openGroup = open ? [] : ids;
  telemetry("inline_toggle", { threads: ids, open: !open });
  layoutThreads();
  if (!open) bringAnchorUp();
}

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const POP_TOP = 56; // below the top bar
const POP_MARGIN = 16;
const POP_MIN_HEIGHT = 260;

// The popover is fixed to the viewport: its top follows the passage but stays on screen, and its height
// is whatever room is left, so it never spills below the window. Default width is a readable line length;
// a dragged width (and its distance from the window's right edge) is remembered.
function positionPopover() {
  const pop = $("#margin-pop");
  if (pop.hidden || !openAnchorEl) return;
  const anchor = openAnchorEl.getBoundingClientRect();
  const top = clamp(anchor.top, POP_TOP, Math.max(POP_TOP, window.innerHeight - POP_MIN_HEIGHT - POP_MARGIN));
  pop.style.top = `${top}px`;
  pop.style.maxHeight = `${window.innerHeight - top - POP_MARGIN}px`;

  const saved = JSON.parse(localStorage.getItem("ginmi.popSize") ?? "null");
  let width, left;
  if (saved) {
    width = clamp(saved.width, 320, window.innerWidth - 80);
    left = window.innerWidth - saved.rightGap - width;
  } else {
    const reviewRight = $("#review").getBoundingClientRect().right;
    const gutter = window.innerWidth - reviewRight;
    width = clamp(gutter - 3 * POP_MARGIN, 360, 760);
    left = reviewRight + Math.max(POP_MARGIN, (gutter - width) / 2);
  }
  pop.style.width = `${width}px`;
  pop.style.left = `${clamp(left, POP_MARGIN, window.innerWidth - width - POP_MARGIN)}px`;
}
let positionQueued = false;
const queuePosition = () => {
  if (positionQueued) return;
  positionQueued = true;
  requestAnimationFrame(() => {
    positionQueued = false;
    positionPopover();
  });
};
window.addEventListener("resize", queuePosition);
window.addEventListener("scroll", queuePosition, { passive: true });
document.addEventListener("toggle", queuePosition, true);

// 2: when a thread opens, scroll its passage near the top so the popover gets most of the screen height.
function bringAnchorUp() {
  if (!openAnchorEl) return;
  const top = openAnchorEl.getBoundingClientRect().top;
  if (top < POP_TOP || top > window.innerHeight * 0.25) window.scrollBy({ top: top - POP_TOP - 16, behavior: "smooth" });
}

// 6: drag either edge of the popover to resize it; the opposite edge stays put. Double-press resets.
let popLastPress = 0;
for (const handle of document.querySelectorAll("#margin-pop .pop-resize")) {
  const isLeft = handle.classList.contains("left");
  let fixedEdge = 0;
  let downX = 0;
  handle.addEventListener("pointerdown", (e) => {
    if (e.timeStamp - popLastPress < 400) {
      localStorage.removeItem("ginmi.popSize");
      popLastPress = 0;
      return positionPopover();
    }
    downX = e.clientX;
    const rect = $("#margin-pop").getBoundingClientRect();
    fixedEdge = isLeft ? rect.right : rect.left;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const maxWidth = isLeft ? fixedEdge - POP_MARGIN : window.innerWidth - POP_MARGIN - fixedEdge;
    const width = clamp(isLeft ? fixedEdge - e.clientX : e.clientX - fixedEdge, 320, maxWidth);
    const right = isLeft ? fixedEdge : fixedEdge + width;
    localStorage.setItem("ginmi.popSize", JSON.stringify({ width, rightGap: window.innerWidth - right }));
    positionPopover();
  });
  handle.addEventListener("pointerup", (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing");
    // Only a click without movement counts toward a double-click reset.
    const moved = Math.abs(e.clientX - downX) > 3;
    popLastPress = moved ? 0 : e.timeStamp;
    if (!moved) return;
    telemetry("popover_resize", { edge: isLeft ? "left" : "right", ...JSON.parse(localStorage.getItem("ginmi.popSize") ?? "{}") });
  });
}

// 3: the follow-up box is pinned to the popover's bottom and replies to the active thread.
const popTarget = () => threads.get(openGroup.includes(activeThread) ? activeThread : openGroup.at(-1));

function renderPopFoot() {
  const t = popTarget();
  const foot = $("#margin-pop .pop-foot");
  const input = $("#pop-input");
  foot.hidden = !t && !draft;
  if (draft) {
    input.disabled = $("#pop-send").disabled = false;
    input.placeholder = "Ask a question about this… (⌘↵)";
    $("#pop-replying").textContent = "";
    return;
  }
  if (!t) return;
  input.disabled = t.status === "running";
  input.placeholder = t.status === "running" ? "Waiting for the answer…" : "Follow up… (⌘↵)";
  $("#pop-send").disabled = input.disabled;
  const where = t.anchor.kind === "diagram" ? t.anchor.label : t.anchor.kind === "general" ? "whole review" : `“${t.anchor.quote}”`;
  $("#pop-replying").textContent = openGroup.length > 1 ? `Replying to ${where}` : "";
}

async function sendFollowUp(t, text) {
  t.messages.push({ role: "user", text });
  t.status = "running";
  t.error = null;
  renderThread(t);
  await post(`threads/${t.id}/messages`, { text }).catch((err) => {
    t.status = "idle";
    t.error = err.message;
    renderThread(t);
  });
}

const sendFromPop = () => {
  if (draft) return askDraft();
  const t = popTarget();
  const text = $("#pop-input").value.trim();
  if (!t || !text || t.status === "running") return;
  $("#pop-input").value = "";
  autosizeInput();
  sendFollowUp(t, text).then(() => {
    const cards = $("#margin-pop .pop-cards");
    cards.scrollTop = cards.scrollHeight;
  });
};
// The reply box grows with its text, up to 40% of the window, then scrolls.
function autosizeInput() {
  const input = $("#pop-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}
$("#pop-input").addEventListener("input", autosizeInput);
$("#pop-send").addEventListener("click", sendFromPop);
$("#pop-todo").addEventListener("click", async () => {
  const t = popTarget();
  const text = $("#pop-input").value.trim();
  if (!text || (!t && !draft)) return;
  // From a draft, this creates the thread holding just the TODO, without asking the model.
  if (draft) await post("threads", { anchor: draft.anchor, todo: text });
  else await post(`threads/${t.id}/todos`, { text });
  $("#pop-input").value = "";
  autosizeInput();
  const cards = $("#margin-pop .pop-cards");
  cards.scrollTop = cards.scrollHeight;
});
$("#pop-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendFromPop();
  if (e.key === "Escape") $("#pop-close").click();
});

// Rebuild the comment bubbles and the popover's contents.
function layoutThreads() {
  document.querySelectorAll(".bubble, .inline-general, .bubble-wrap, #margin-pop .thread").forEach((e) => e.remove());
  $("#margin-pop").hidden = true;
  openAnchorEl = null;
  const sorted = [...threads.values()].sort(createdOrder);

  const groups = new Map(); // block (or null for general) -> threads
  for (const t of sorted) {
    const block = anchorBlock(t);
    groups.set(block, [...(groups.get(block) ?? []), t]);
  }
  for (const [block, group] of groups) {
    const ids = group.map((t) => t.id);
    const open = ids.some((tid) => openGroup.includes(tid));
    const bubble = el(
      "button",
      { type: "button", class: `bubble${open ? " open" : ""}`, title: open ? "Hide thread" : "Show thread", onclick: (e) => (e.stopPropagation(), toggleThreads(ids)) },
      `💬 ${group.length}${group.some((t) => todosOf(t.id).length) ? " · TODO" : ""}`,
    );
    let anchorEl = block;
    if (!block) {
      anchorEl = el("div", { class: "inline-general" }, el("span", { class: "hint" }, "Questions about the whole review "), bubble);
      const firstH2 = $("#review h2");
      firstH2 ? firstH2.before(anchorEl) : $("#review").append(anchorEl);
    } else if (block.classList.contains("mermaid-wrap")) {
      block.after(el("div", { class: "bubble-wrap" }, bubble));
    } else block.append(bubble);
    if (open) {
      $("#margin-pop .pop-head .hint").textContent = "Thread";
      openGroup = ids;
      openAnchorEl = anchorEl;
      $("#margin-pop").hidden = false;
      for (const t of group) renderThread(t);
    }
  }
  if (!openAnchorEl) openGroup = [];
  if (draft && !openGroup.length) renderDraft();
  setActive(openGroup.at(-1) ?? null);
  positionPopover();
  renderPopFoot();
}

function placeCard(t, card) {
  if (openGroup.includes(t.id)) $("#margin-pop .pop-cards").append(card);
}

$("#pop-close").addEventListener("click", () => {
  openGroup = [];
  draft = null;
  $("#pop-input").value = "";
  autosizeInput();
  layoutThreads();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#margin-pop").hidden && !e.target.closest("textarea, input")) $("#pop-close").click();
});

// Clicking highlighted text opens its thread.
$("#review").addEventListener("click", (e) => {
  if (!window.getSelection().isCollapsed || e.target.closest(".thread, .bubble, button, a, .mermaid-wrap, input, textarea")) return;
  const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const caret = pos ? [pos.offsetNode, pos.offset] : (() => { const r = document.caretRangeFromPoint?.(e.clientX, e.clientY); return r && [r.startContainer, r.startOffset]; })();
  if (!caret) return;
  const hit = [...threads.values()].find((t) => anchorRange(t)?.isPointInRange(...caret));
  if (!hit) return;
  toggleThreads([hit.id]);
});

// ---------- Asking ----------

// The block a new question lines up with: the paragraph or list item holding the selection.
const blockOf = (node) => (node.nodeType === Node.TEXT_NODE ? node.parentElement : node).closest("li, p, h1, h2, h3, h4, pre, blockquote, td, th");

// Open the popover as a draft thread for a new question, the same way an existing thread opens.
function openDraft(anchor, anchorEl, range = null) {
  $("#ask-button").hidden = true;
  openGroup = [];
  draft = { anchor, anchorEl: anchorEl ?? $("#review h1") ?? $("#review"), range };
  $("#pop-input").value = "";
  autosizeInput();
  layoutThreads();
  bringAnchorUp();
  $("#pop-input").focus({ preventScroll: true });
}

function renderDraft() {
  const { anchor } = draft;
  const where = anchor.kind === "diagram" ? `◇ ${anchor.label}` : anchor.kind === "general" ? "whole review" : `“${anchor.quote}”`;
  const card = el(
    "div",
    { class: "thread active draft" },
    el("div", { class: "thread-head", title: where }, el("span", {}, anchor.item === "general" ? "General" : `Item ${anchor.item}`), el("span", { class: "quote" }, where)),
    el("div", { class: "thread-body" }, el("p", { class: "hint" }, "Ask a question below (⌘↵), or save it as a TODO for the handoff.")),
  );
  $("#margin-pop .pop-cards").append(card);
  openAnchorEl = draft.anchorEl;
  $("#margin-pop .pop-head .hint").textContent = "New question";
  $("#margin-pop").hidden = false;
}

async function askDraft() {
  const question = $("#pop-input").value.trim();
  if (!question || !draft) return;
  const { anchor } = draft;
  $("#pop-input").value = "";
  autosizeInput();
  $("#pop-input").disabled = $("#pop-send").disabled = true;
  window.getSelection().removeAllRanges();
  try {
    await post("threads", { anchor, question });
  } catch (err) {
    $("#pop-input").value = question;
    autosizeInput();
    $("#pop-input").disabled = $("#pop-send").disabled = false;
    alert(`Could not start thread: ${err.message}`);
  }
}

document.addEventListener("mouseup", (e) => {
  if (e.target.closest("#ask-button, #margin-pop")) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    const node = sel.anchorNode?.parentElement;
    if (!text || !node?.closest("#review") || node.closest(".decision")) {
      $("#ask-button").hidden = true;
      return;
    }
    const section = node.closest(".item");
    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const anchor = { kind: "text", item: section?.dataset.item ?? "general", itemTitle: section?.dataset.title, quote: text };
    const button = $("#ask-button");
    button.hidden = false;
    button.style.left = `${rect.right + window.scrollX - 20}px`;
    button.style.top = `${rect.bottom + window.scrollY + 6}px`;
    button.onclick = () => openDraft(anchor, blockOf(range.startContainer) ?? section, range);
  });
});

$("#ask-general").addEventListener("click", () => openDraft({ kind: "general", item: "general" }, null));

// ---------- Threads panel ----------

const toolLine = (t) => {
  const a = t.args ?? {};
  const detail = a.path ?? a.command ?? a.pattern ?? JSON.stringify(a);
  return el("div", { title: detail }, `${t.name} ${detail}`);
};

function renderMessage(m) {
  if (m.role === "user") {
    const div = el("div", { class: "msg user" });
    div.innerHTML = mdUser.render(m.text);
    return div;
  }
  const div = el("div", { class: "msg assistant" });
  if (m.tools?.length) {
    const n = m.tools.length;
    const last = m.tools.at(-1);
    const label = m.streaming ? `${n} tool call${n > 1 ? "s" : ""} · ${last.name} ${last.args?.path ?? last.args?.command ?? ""}` : `${n} tool call${n > 1 ? "s" : ""}`;
    div.append(el("details", { class: "tools" }, el("summary", {}, label), ...m.tools.map(toolLine)));
  }
  if (m.text) {
    const body = el("div");
    body.innerHTML = md.render(m.text);
    linkSources(body, "thread");
    div.append(body);
  }
  if (m.error) div.append(el("div", { class: "msg error" }, m.error));
  return div;
}

// pi makes one tool call per assistant step; fold tool-only steps into the next step that has text.
function mergeToolSteps(messages) {
  const out = [];
  let carried = [];
  for (const m of messages) {
    if (m.role === "assistant" && !m.text && !m.error) {
      carried.push(...(m.tools ?? []));
      continue;
    }
    if (m.role === "assistant") out.push({ ...m, tools: [...carried, ...(m.tools ?? [])] });
    else {
      if (carried.length) out.push({ role: "assistant", text: "", tools: carried });
      out.push(m);
    }
    if (m.role === "assistant" || carried.length) carried = [];
  }
  if (carried.length) out.push({ role: "assistant", text: "", tools: carried });
  return out;
}

const itemOrder = (item) => [...items.keys()].indexOf(item);

function renderThread(t) {
  const existing = document.querySelector(`.thread[data-thread="${t.id}"]`);
  const where = t.anchor.kind === "diagram" ? `◇ ${t.anchor.label}` : t.anchor.kind === "general" ? "whole review" : `“${t.anchor.quote}”`;
  const card = el("div", { class: `thread${activeThread === t.id ? " active" : ""}`, "data-thread": t.id });
  const del = el("button", { type: "button", class: "thread-delete", title: "Delete this thread" }, "Delete");
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this thread? It will be removed from the review feedback.")) return;
    await post(`threads/${t.id}/delete`, {}).catch((err) => alert(`Could not delete thread: ${err.message}`));
  });
  const head = el("div", { class: "thread-head", title: where }, el("span", {}, t.anchor.item === "general" ? "General" : `Item ${t.anchor.item}`), el("span", { class: "quote" }, where), del);
  // With several threads on one passage, clicking a header picks which one the reply box answers.
  head.addEventListener("click", () => {
    setActive(t.id);
    renderPopFoot();
  });
  const body = el("div", { class: "thread-body" }, ...mergeToolSteps(t.messages).map(renderMessage));
  if (t.streaming) body.append(t.streaming.el);
  for (const todo of todosOf(t.id)) body.append(todoCard(todo));
  if (t.status === "running") {
    body.append(el("div", { class: "status" }, el("span", { class: "spinner" }), "Answering…", el("button", { type: "button", onclick: () => post(`threads/${t.id}/abort`, {}) }, "Stop")));
  } else {
    if (t.error) body.append(el("div", { class: "msg error" }, t.error));
  }
  card.append(head, body);
  if (existing) existing.replaceWith(card);
  else placeCard(t, card);
  if (openGroup.includes(t.id)) renderPopFoot();
}

function streamingMessage(t) {
  if (!t.streaming) {
    t.streaming = { text: "", tools: [], el: el("div", { class: "msg assistant" }) };
  }
  return t.streaming;
}

function redrawStreaming(t) {
  const s = t.streaming;
  s.el.replaceChildren(renderMessage({ role: "assistant", text: s.text, tools: s.tools, streaming: true }));
}

async function reloadThread(tid) {
  const fresh = await fetch(api("state")).then((r) => r.json());
  const t = fresh.threads.find((x) => x.id === tid);
  if (!t) return;
  threads.set(tid, t);
  renderThread(t);
  refreshHighlights();
}

function onEvent(ev) {
  if (ev.type === "base_status") return setBaseStatus(ev);
  if (ev.type === "thread_created") {
    threads.set(ev.thread.id, ev.thread);
    openGroup = [ev.thread.id];
    draft = null;
    refreshHighlights();
    layoutThreads();
    bringAnchorUp();
    return;
  }
  if (ev.type === "todos") {
    state.todos = ev.todos;
    renderTodoCount();
    for (const tid of openGroup) if (threads.has(tid)) renderThread(threads.get(tid));
    layoutBubblesOnly();
    return;
  }
  if (ev.type === "thread_deleted") {
    threads.delete(ev.thread);
    openGroup = openGroup.filter((tid) => tid !== ev.thread);
    if (activeThread === ev.thread) activeThread = null;
    layoutThreads();
    return;
  }
  const t = threads.get(ev.thread);
  if (!t) return;
  if (ev.type === "thread_status") {
    t.status = ev.status;
    t.error = ev.error;
    if (ev.status === "idle") {
      t.streaming = null;
      reloadThread(t.id);
    } else renderThread(t);
  } else if (ev.type === "assistant_start") {
    if (t.streaming?.text) t.messages.push({ role: "assistant", text: t.streaming.text, tools: t.streaming.tools });
    t.streaming = null;
    streamingMessage(t);
    renderThread(t);
  } else if (ev.type === "delta") {
    streamingMessage(t).text += ev.delta;
    redrawStreaming(t);
  } else if (ev.type === "tool") {
    streamingMessage(t).tools.push({ name: ev.name, args: ev.args });
    redrawStreaming(t);
  } else if (ev.type === "thread_error") {
    t.error = ev.error;
  }
}

function setBaseStatus(base) {
  const s = $("#base-status");
  s.className = base.status === "error" ? "error" : "";
  s.textContent = base.status === "warming" ? "Warming up the agent…" : base.status === "error" ? `Agent error: ${base.error}` : "";
}

// ---------- Paths ----------

// macOS resolves /tmp to /private/tmp; show and copy the familiar /tmp form. Display also shortens the home directory.
const tmpPath = (p) => p.replace(/^\/private\/tmp\//, "/tmp/");
const shortPath = (p) => tmpPath(p).replace(/^\/Users\/[^/]+\//, "~/");

function pathChip(label, path) {
  const chip = el("button", { type: "button", class: "path-chip", title: `${path}\n(click to copy)` }, el("span", { class: "label" }, label), shortPath(path));
  chip.addEventListener("click", async () => {
    await navigator.clipboard.writeText(tmpPath(path));
    chip.lastChild.textContent = "copied ✓";
    setTimeout(() => (chip.lastChild.textContent = shortPath(path)), 1200);
  });
  return chip;
}

async function renderPaths() {
  const { worktrees } = await fetch(api("worktrees")).then((r) => r.json()).catch(() => ({ worktrees: [] }));
  $("#paths").replaceChildren(
    pathChip("ginmi", state.workspace),
    ...worktrees.map((w) => pathChip(`worktree (${w.branch})`, w.path)),
  );
}
window.addEventListener("focus", () => state && renderPaths());

// ---------- TODOs ----------

const todosOf = (tid) => (state.todos ?? []).filter((x) => x.thread === tid).sort((a, b) => a.created.localeCompare(b.created));

function todoCard(todo) {
  const card = el("div", { class: "todo", "data-todo": todo.id });
  const view = () => {
    const body = el("div", { class: "todo-text" });
    body.innerHTML = mdUser.render(todo.text);
    card.replaceChildren(
      el(
        "div",
        { class: "todo-head" },
        el("span", {}, "TODO for handoff"),
        el("button", { type: "button", onclick: edit }, "Edit"),
        el("button", { type: "button", onclick: remove }, "Delete"),
      ),
      body,
    );
  };
  const edit = () => {
    const input = el("textarea", { class: "todo-edit" });
    input.value = todo.text;
    const save = async () => {
      const text = input.value.trim();
      if (!text) return remove();
      await post(`todos/${todo.id}`, { text });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
      if (e.key === "Escape") (e.stopPropagation(), view());
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight + 2}px`;
    });
    card.replaceChildren(
      el("div", { class: "todo-head" }, el("span", {}, "TODO for handoff"), el("button", { type: "button", onclick: save }, "Save"), el("button", { type: "button", onclick: view }, "Cancel")),
      input,
    );
    input.focus();
    input.dispatchEvent(new Event("input"));
  };
  const remove = async () => {
    if (confirm("Delete this TODO?")) await post(`todos/${todo.id}/delete`, {});
  };
  view();
  return card;
}

// Rebuild bubbles (their TODO markers) while keeping the popover's current contents.
function layoutBubblesOnly() {
  const scroll = $("#margin-pop .pop-cards").scrollTop;
  layoutThreads();
  $("#margin-pop .pop-cards").scrollTop = scroll;
}

let todoCursor = 0;
function renderTodoCount() {
  const n = (state.todos ?? []).length;
  const b = $("#todo-count");
  b.hidden = !n;
  b.textContent = `${n} TODO${n === 1 ? "" : "s"}`;
}
$("#todo-count").addEventListener("click", () => {
  const todos = [...state.todos].sort((a, b) => a.created.localeCompare(b.created));
  if (!todos.length) return;
  const todo = todos[todoCursor++ % todos.length];
  const details = anchorBlock(threads.get(todo.thread))?.closest("details");
  if (details) details.open = true;
  draft = null;
  openGroup = [todo.thread];
  layoutThreads();
  bringAnchorUp();
  document.querySelector(`#margin-pop .todo[data-todo="${todo.id}"]`)?.scrollIntoView({ block: "nearest" });
});

// ---------- Handoff ----------

$("#copy-handoff").addEventListener("click", async () => {
  const ws = tmpPath(state.workspace);
  const line = `Work on the review feedback in ${ws}: run \`ginmi feedback ${ws}\` and follow the instructions at the top of its output.`;
  await navigator.clipboard.writeText(line);
  const b = $("#copy-handoff");
  b.textContent = "Copied ✓";
  setTimeout(() => (b.textContent = "Copy feedback handoff"), 1500);
  telemetry("copy_handoff");
});

// ---------- Startup ----------

async function main() {
  state = await fetch(api("state")).then((r) => r.json());
  if (state.error) {
    $("#review").textContent = state.error;
    return;
  }
  const m = state.manifest;
  document.title = `ginmi · ${m.title ?? id}`;
  const mr = $("#mr-link");
  if (m.url) {
    mr.href = m.url;
    mr.textContent = m.title ?? m.url;
  }
  setBaseStatus(state.base);
  renderPaths();
  renderTodoCount();
  renderReview();
  for (const t of state.threads) threads.set(t.id, t);
  refreshHighlights();
  layoutThreads();
  await renderDiagrams().catch((e) => console.error("mermaid", e));

  const events = new EventSource(api("events"));
  events.onmessage = (e) => onEvent(JSON.parse(e.data));

  telemetry("page_open", { items: items.size, threads: threads.size });
  document.addEventListener("visibilitychange", () => telemetry(document.hidden ? "page_hidden" : "page_visible"));
}

main();
