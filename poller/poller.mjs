#!/usr/bin/env node
// Post-it transcript poller (issue #4). Node 18+, no dependencies (built-in fetch).
//
// Watches recent Grok voice conversations (REST, read-only), waits until one has been quiet for
// QUIET_MINUTES, then files it into a TOPIC PAPER on mogesjohnson/post-it-board: one pin per topic whose
// page 1 is a living summary (<= 1,500 characters). The local llama.cpp model decides whether the chat
// matches an existing topic (read from the board's public, read-only Supabase API) and merges it in
// (`edit` of page 1), or starts a NEW topic (`add`). Commands go to the board's `inbox` branch.
// Design: docs/transcript-automation.md. Usage: poller/README.md.
//
//   node poller/poller.mjs                 # run the loop (normally via poller/start.sh)
//   node poller/poller.mjs --once          # one poll cycle, then exit (add --wait to wait for results)
//   node poller/poller.mjs --dry-run       # write command files locally instead of pushing
//   node poller/poller.mjs --since 2026-10-11T20:00:00Z   # override the first-run start time
//   node poller/poller.mjs --health        # print health.json; exit 1 if unhealthy or stale
//   node poller/poller.mjs --summarize-file transcript.txt  # run the summarizer on a text file
//   node poller/poller.mjs --send-command cmd.json [--name file.json]   # push one command, wait for result
//   node poller/poller.mjs --reset <convKey>  # retry a needs_attention conversation (new file name)
//   node poller/poller.mjs --compact [--dry-run] [--threshold 1500] [--target 1000] [--json]   # weekly compaction
//
// Privacy: logs contain only ids (hashed), counts, timestamps and statuses. Never message text,
// cookies or tokens.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */
const TZ = "America/New_York";
const LIMITS = { pin: 200, title: 200, body: 5000 };
export const OPT_OUT = ["don't post this", "dont post this", "do not post", "off the record"];
export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function loadConfig(env = process.env, argv = []) {
  const args = parseArgs(argv);
  const home = env.POLLER_HOME || path.join(os.homedir(), ".post-it-poller");
  const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
  const cfg = {
    args,
    home,
    reader: env.READER || "rest",
    grokBase: (env.GROK_BASE_URL || "https://grok.com").replace(/\/+$/, ""),
    quietMinutes: num(env.QUIET_MINUTES, 10),
    pollSeconds: num(env.POLL_SECONDS, 90),
    maxBackoffSeconds: num(env.MAX_BACKOFF_SECONDS, 600),
    // auth failures (expired cookie, challenge page) don't heal by retrying: back off further (30 min) so a dead
    // session never looks like a bot hammering grok.com. A new GROK_COOKIE needs a restart anyway.
    authMaxBackoffSeconds: num(env.AUTH_MAX_BACKOFF_SECONDS, 1800),
    pageSize: num(env.GROK_PAGE_SIZE, 60),
    repo: env.INBOX_REPO || "mogesjohnson/post-it-board",
    branch: env.INBOX_BRANCH || "inbox",
    githubApi: (env.GITHUB_API || "https://api.github.com").replace(/\/+$/, ""),
    llamaDir: env.LLAMA_DIR || "/workspace/llm/llama-b11559",
    llamaModel: env.LLAMA_MODEL || "/workspace/llm/qwen35-2b-q4km.gguf",
    llamaThreads: num(env.LLAMA_THREADS, 8),
    llamaPort: num(env.LLAMA_PORT, 0), // 0 = pick a free port
    minFreeMb: num(env.SUMMARIZER_MIN_FREE_MB, 1500),
    pinOverride: env.POLLER_PIN_OVERRIDE || "", // testing only: force the pin title of a NEW topic
    // topics the poller never merges into or compacts (exact titles, comma-separated): the welcome note by default
    topicsExclude: (env.TOPICS_EXCLUDE ?? "Post-it Board").split(",").map(s => s.trim()).filter(Boolean),
    maxTopics: num(env.MAX_TOPICS, 40), // most recently updated topics offered to the matcher
    compactThreshold: num(env.COMPACT_THRESHOLD, 1500),
    compactTarget: num(env.COMPACT_TARGET, 1000),
    dryRun: !!args["dry-run"],
    since: args.since || env.POLLER_SINCE || "",
  };
  if (cfg.pollSeconds < 60 && !env.POLL_SECONDS_ALLOW_FAST) cfg.pollSeconds = 60; // be gentle with grok.com
  if (cfg.pollSeconds > 120 && !env.POLL_SECONDS_ALLOW_SLOW) cfg.pollSeconds = 120;
  cfg.stateDir = cfg.dryRun ? path.join(home, "dry-run") : home;
  return cfg;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith("--")) { out[k] = v; i++; } else out[k] = true;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */
export const convKey = id => createHash("sha256").update(String(id)).digest("hex").slice(0, 10);
export const ms = t => (typeof t === "number" ? t : Date.parse(t));
export function fmtUtcCompact(t) {
  return new Date(ms(t)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261006T011512Z
}
export function nyDate(t) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms(t)));
}
export function nyTime(t) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ms(t)));
}
const norm = s => String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const sleep = t => new Promise(r => setTimeout(r, t));

export class PollerError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

/* ------------------------------------------------------------------ */
/* logging, state, health                                              */
/* ------------------------------------------------------------------ */
export function makeLogger(file, { echo = true } = {}) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  return (level, msg, fields = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
    if (file) fs.appendFileSync(file, line + "\n");
    if (echo) (level === "error" ? console.error : console.log)(line);
  };
}

function writeJsonAtomic(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
export function saveState(file, state) { writeJsonAtomic(file, state, 0o600); }

export function makeHealth(file, nowFn = Date.now) {
  let h = loadState(file) || { ok: true, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, kind: null };
  const save = () => { h.updatedAt = new Date(nowFn()).toISOString(); h.pid = process.pid; writeJsonAtomic(file, h); };
  return {
    get: () => h,
    ok() { h = { ...h, ok: true, lastSuccessAt: new Date(nowFn()).toISOString(), consecutiveFailures: 0, kind: null }; save(); },
    fail(kind, message) {
      h = { ...h, ok: false, kind, lastError: { kind, message: String(message).slice(0, 300), at: new Date(nowFn()).toISOString() },
            consecutiveFailures: (h.consecutiveFailures || 0) + 1 };
      save();
    },
    // a non-fatal problem in one part (e.g. the summarizer) while reading still works
    warn(kind, message) { this.fail(kind, message); },
  };
}

// --health: unhealthy if the last loop failed, or the heartbeat is stale (no loop for > staleMinutes)
export function healthVerdict(h, nowMs = Date.now(), staleMinutes = 10) {
  if (!h) return { healthy: false, reason: "no health.json (poller never ran?)" };
  if (!h.ok) return { healthy: false, reason: `last loop failed: ${h.kind}` };
  const age = (nowMs - Date.parse(h.updatedAt || 0)) / 60000;
  if (!(age <= staleMinutes)) return { healthy: false, reason: `stale heartbeat (${age.toFixed(1)} min old)` };
  return { healthy: true, reason: "ok" };
}

/* ------------------------------------------------------------------ */
/* reader: grok.com REST (read-only)                                   */
/* ------------------------------------------------------------------ */
function grokHeaders(cookie, withBody) {
  const h = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://grok.com/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": BROWSER_UA,
    cookie,
  };
  if (withBody) { h["content-type"] = "application/json"; h.origin = "https://grok.com"; }
  return h;
}

// Classify one HTTP response. Throws PollerError(kind) or returns parsed JSON.
export async function parseGrokResponse(res, what) {
  const ct = (res.headers?.get?.("content-type") || "").toLowerCase();
  if (res.status === 401 || res.status === 403) {
    throw new PollerError("auth", `${what}: HTTP ${res.status} (sign in to grok.com again / refresh GROK_COOKIE${/html/.test(ct) ? "; challenge page" : ""})`, { status: res.status });
  }
  if (res.status === 429) {
    const ra = Number(res.headers?.get?.("retry-after"));
    throw new PollerError("network", `${what}: HTTP 429 rate limited`, { status: 429, retryAfterSec: Number.isFinite(ra) ? ra : undefined });
  }
  const text = await res.text();
  const looksHtml = /html/.test(ct) || /^\s*<(!doctype|html)/i.test(text);
  if (looksHtml) {
    // a login redirect or a Cloudflare/anti-bot challenge instead of JSON: stop and alert, never bypass
    const challenge = /cf-chl|challenge-platform|just a moment|captcha|cf_clearance/i.test(text);
    throw new PollerError("auth", `${what}: got an HTML page instead of JSON${challenge ? " (challenge page)" : " (login page?)"} HTTP ${res.status}`, { status: res.status });
  }
  if (!res.ok) throw new PollerError("network", `${what}: HTTP ${res.status}`, { status: res.status });
  try { return JSON.parse(text); } catch { throw new PollerError("schema", `${what}: response is not JSON`); }
}

const isIso = v => typeof v === "string" && !Number.isNaN(Date.parse(v));

export function validateList(data) {
  if (!data || !Array.isArray(data.conversations)) throw new PollerError("schema", "list: missing conversations[]");
  return data.conversations.map((c, i) => {
    if (!c || typeof c.conversationId !== "string" || !isIso(c.modifyTime) || !isIso(c.createTime)) {
      throw new PollerError("schema", `list: conversation[${i}] lacks conversationId/createTime/modifyTime`);
    }
    if (c.mediaTypes !== undefined && !Array.isArray(c.mediaTypes)) throw new PollerError("schema", `list: conversation[${i}].mediaTypes is not an array`);
    return { id: c.conversationId, createTime: c.createTime, modifyTime: c.modifyTime, mediaTypes: c.mediaTypes || [] };
  });
}

export function validateResponses(data) {
  if (!data || !Array.isArray(data.responses)) throw new PollerError("schema", "load-responses: missing responses[]");
  return data.responses.map((r, i) => {
    if (!r || typeof r.sender !== "string" || typeof r.message !== "string" || !isIso(r.createTime)) {
      throw new PollerError("schema", `load-responses: response[${i}] lacks sender/message/createTime`);
    }
    return { id: r.responseId || null, sender: r.sender.toLowerCase(), text: r.message, createTime: r.createTime };
  }).sort((a, b) => ms(a.createTime) - ms(b.createTime));
}

export function createRestReader({ baseUrl = "https://grok.com", cookie, fetchFn = fetch, pageSize = 60 }) {
  if (!cookie) throw new PollerError("auth", "GROK_COOKIE is not set");
  const base = `${baseUrl}/rest/app-chat`;
  const req = async (what, url, init) => {
    let res;
    try { res = await fetchFn(url, { ...init, redirect: "manual" }); }
    catch (e) { throw new PollerError("network", `${what}: ${e.cause?.code || e.name || "fetch failed"}`); }
    if (res.status >= 300 && res.status < 400) throw new PollerError("auth", `${what}: HTTP ${res.status} redirect (login?)`, { status: res.status });
    return parseGrokResponse(res, what);
  };
  return {
    kind: "rest",
    // page 1 only (most recent)
    async listRecentConversations() {
      return validateList(await req("list", `${base}/conversations?pageSize=${pageSize}`, { method: "GET", headers: grokHeaders(cookie, false) }));
    },
    // response-node -> responseIds -> POST load-responses {"responseIds": [...]}
    async getMessages(id) {
      const enc = encodeURIComponent(id);
      const nodes = await req("response-node", `${base}/conversations/${enc}/response-node`, { method: "GET", headers: grokHeaders(cookie, false) });
      if (!nodes || !Array.isArray(nodes.responseNodes)) throw new PollerError("schema", "response-node: missing responseNodes[]");
      const responseIds = [...new Set(nodes.responseNodes.map(n => n && n.responseId).filter(x => typeof x === "string"))];
      if (!responseIds.length) return [];
      const data = await req("load-responses", `${base}/conversations/${enc}/load-responses`, {
        method: "POST", headers: grokHeaders(cookie, true), body: JSON.stringify({ responseIds }),
      });
      return validateResponses(data);
    },
  };
}

export function createBrowserReader() {
  // TODO (C2 fallback): drive a persistent, signed-in browser profile and call the same endpoints in-page.
  const nope = async () => { throw new PollerError("schema", "READER=browser is not implemented yet (TODO stub); use READER=rest"); };
  return { kind: "browser", listRecentConversations: nope, getMessages: nope };
}

/* ------------------------------------------------------------------ */
/* quiet detection and transcript prep                                 */
/* ------------------------------------------------------------------ */
// Finished when now - max(newest message createTime, conversation modifyTime) >= QUIET_MINUTES.
export function quietInfo({ nowMs, newestMs, modifyMs, firstSeenAtMs, quietMinutes }) {
  let ref = Math.max(newestMs || 0, modifyMs || 0);
  let method = "timestamps";
  if (ref > nowMs + 60_000) { ref = firstSeenAtMs ?? nowMs; method = "observed"; } // clock skew: use our own clock
  const quietMs = nowMs - ref;
  return { quiet: quietMs >= quietMinutes * 60_000, quietMs, method };
}

export function hasOptOut(msgs) {
  return msgs.some(m => m.sender === "human" && OPT_OUT.some(p => m.text.toLowerCase().replace(/[’]/g, "'").includes(p)));
}

// Ara's "post it": everything up to her "Posted." confirmation counts as posted already
export function araPostPoint(msgs) {
  let idx = 0;
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].sender === "assistant" && /^\s*posted\b/i.test(msgs[i].text) &&
        msgs[i - 1].sender === "human" && /\bpost it\b/i.test(msgs[i - 1].text)) idx = i + 1;
  }
  return idx;
}

const stripMarkup = s => s.replace(/<grok:render[\s\S]*?<\/grok:render>/g, "").replace(/<[^>]{1,200}>/g, "").trim();
export function formatTranscript(msgs) {
  return msgs.map(m => `${m.sender === "human" ? "User" : "Grok"}: ${stripMarkup(m.text)}`).join("\n");
}

// ~3 chars per token for English. Context: transcript + prompt overhead + output, 4096..16384.
export const CHARS_PER_TOKEN = 3.0; // measured 3.1-3.6 on the synthetic transcripts; 3.0 keeps the prompt inside the context
export const estTokens = s => Math.ceil(s.length / CHARS_PER_TOKEN);
export const OVERHEAD_TOKENS = 700, MAX_OUT_TOKENS = 900, MAX_CTX = 16384, MIN_CTX = 4096;
// extraChars: other prompt text sharing the context (topic list, current summary)
export function fitTranscript(text, maxCtx = MAX_CTX, extraChars = 0) {
  const PREFIX = "[earlier part of the conversation omitted]\n";
  const budgetChars = Math.floor((maxCtx - OVERHEAD_TOKENS - MAX_OUT_TOKENS) * CHARS_PER_TOKEN) - PREFIX.length - extraChars;
  let truncated = false;
  if (text.length > budgetChars) {
    // keep the END (the latest turns matter most), cut at a line boundary
    let cut = text.slice(text.length - budgetChars);
    const nl = cut.indexOf("\n");
    if (nl > 0 && nl < 2000) cut = cut.slice(nl + 1);
    text = PREFIX + cut;
    truncated = true;
  }
  const need = estTokens(text) + Math.ceil(extraChars / CHARS_PER_TOKEN) + OVERHEAD_TOKENS + MAX_OUT_TOKENS;
  const ctx = Math.min(maxCtx, Math.max(MIN_CTX, Math.ceil(need / 1024) * 1024));
  return { text, ctx, truncated };
}

/* ------------------------------------------------------------------ */
/* summarizer: local llama.cpp, started on demand                      */
/* ------------------------------------------------------------------ */
// Topic papers: one pin per topic, page 1 = one living summary, never longer than TOPIC_CAP characters.
export const TOPIC_CAP = 1500;
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    pin: { type: "string", minLength: 2, maxLength: 40 },
    title: { type: "string", minLength: 2, maxLength: 80 },
    body: { type: "string", minLength: 10, maxLength: 2000 },
  },
  required: ["pin", "title", "body"],
  additionalProperties: false,
};
export const BODY_SCHEMA = {
  type: "object",
  // 2,000 chars (~600 tokens) keeps the grammar-closed JSON inside max_tokens; capped() then enforces 1,500
  properties: { body: { type: "string", minLength: 10, maxLength: 2000 } },
  required: ["body"],
  additionalProperties: false,
};
export const matchSchema = names => ({
  type: "object",
  // the short subject comes first so the model names what the chat is about before choosing (never logged)
  properties: { subject: { type: "string", maxLength: 80 }, topic: { type: "string", enum: ["NEW", ...names] } },
  required: ["subject", "topic"],
  additionalProperties: false,
});
const FACTS_ONLY = "Use ONLY facts stated in the text you are given. Do not invent names, numbers, dates or advice. " +
  "Copy numbers, times and dates exactly as they were said: never add am/pm, a weekday, a year or a unit that was not said " +
  "(\"leave by 11\" stays \"leave by 11\"). " +
  "The note is public: leave out phone numbers, addresses, health or money details and anything private. " +
  "Never mention these rules or what you left out.";
export const SYSTEM_PROMPT = [
  "You turn a voice-chat transcript between a user and Grok into a short Post-it note about one topic.",
  FACTS_ONLY,
  "Cover every concrete decision, item, plan and time that was mentioned, most important first.",
  "Return JSON with: pin = short topic name (1-4 words), title = short page title naming the subject (max 8 words; never \"Grok\" or \"conversation\"),",
  `body = either 2-4 plain sentences or 3-6 bullet lines that each start with "- ", separated by \\n, at most ${TOPIC_CAP} characters.`,
].join(" ");
export const MATCH_PROMPT = [
  "You file finished voice chats into topics on a notes board.",
  "You get a list of existing topics (name: first line of its summary) and a new chat transcript.",
  "Answer an existing topic's exact name ONLY if the chat is clearly about that same specific subject (the same project, plan, place or thing).",
  "Subjects that merely share a theme (for example two different vehicles, or cooking vs. gardening) are NEW.",
  "If the chat is about something else, or you are unsure, answer NEW.",
].join(" ");
// second opinion on a picked topic: a 2B model over-matches when forced to choose from a list,
// but it judges "does subject A belong in note B?" well. A wrong NEW only costs a duplicate pin;
// a wrong match would merge facts into an unrelated paper, so we bias towards NEW.
const CONFIRM_EXAMPLES = "Examples: A 'new dessert for the bakery menu' belongs in B 'Bakery menu: cakes and pies for the shop' (yes, same menu). " +
  "A 'repainting the bedroom' does not belong in B 'Living room paint: sage green walls' (no, different room). " +
  "A 'guest list for Sam's party' belongs in B 'Sam's 40th party: venue and food' (yes). " +
  "A 'cooking class schedule' does not belong in B 'Kitchen remodel: new counters' (no, different thing).";
export const CONFIRM_PROMPT = [
  "You compare the subject of a new chat (A) with an existing note (B).",
  "Answer yes if A is the same specific thing as B or a detail of it (for example a new item for the same list, project or plan).",
  "Answer no if A is a different thing, even when both share a broad theme.",
  CONFIRM_EXAMPLES,
].join(" ");
// second confirmation with full context: the note's summary and the chat itself (not just a 3-word subject)
export const CONTEXT_PROMPT = [
  "You check whether a new voice chat continues an existing note on a notes board.",
  "Answer yes only if the chat is about the same specific project, plan, place, event or thing as the note (for example a new detail, update or to-do for it).",
  "Answer no if it is about a different thing, even if it shares a theme or some words.",
  CONFIRM_EXAMPLES,
].join(" ");
export const confirmSchema = { type: "object", properties: { answer: { type: "string", enum: ["yes", "no"] } }, required: ["answer"], additionalProperties: false };
export const MERGE_PROMPT = [
  "You maintain a living summary (a 'topic paper') for one topic on a notes board.",
  "Combine the CURRENT SUMMARY and the NEW CONVERSATION into one updated summary of the whole topic.",
  FACTS_ONLY,
  "Order: decisions first, then open to-dos, then the latest facts. When the new conversation changes or corrects something, keep the new version and drop the old one.",
  "Merge duplicates. Plain text; bullet lines starting with \"- \" are fine.",
  `HARD LIMIT: at most ${TOPIC_CAP} characters in total. Shorter is better.`,
].join(" ");
export const COMPACT_PROMPT = [
  "You shorten a topic summary on a notes board.",
  FACTS_ONLY,
  "Keep decisions, open to-dos and the latest facts first; drop older, repeated or minor details.",
  "Plain text; bullet lines starting with \"- \" are fine.",
].join(" ");
const SHORTEN = (len, limit) =>
  `This summary is ${len} characters, which is over the hard limit. Rewrite it in at most ${limit} characters. ` +
  "Keep decisions, open to-dos and the latest facts first; drop older or minor details. Use only the facts already in it.";

export function validateSummary(obj) {
  if (!obj || typeof obj !== "object") return "not an object";
  for (const k of ["pin", "title", "body"]) if (typeof obj[k] !== "string" || !obj[k].trim()) return `missing ${k}`;
  const extra = Object.keys(obj).filter(k => !["pin", "title", "body"].includes(k));
  if (extra.length) return `extra keys ${extra.join(",")}`;
  return null;
}

export const MAX_BULLETS = 6;
const tidy = b => b.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
// drop repeated lines and repeated sentences (keeps the first occurrence); a safety net against model loops
export function dedupeText(body) {
  const seen = new Set();
  const key = x => x.toLowerCase().replace(/^[-*•\s]+/, "").replace(/[^a-z0-9$]+/g, " ").trim();
  return tidy(body).split("\n").map(line => {
    const parts = line.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [line];
    const kept = parts.filter(p => { const k = key(p); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; });
    const out = kept.join("").trimEnd();
    return line.trim() && (!out.trim() || /^[-*•]\s*$/.test(out.trim())) ? null : out;
  }).filter(l => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function cleanSummary(s) {
  let body = tidy(s.body);
  const lines = body.split("\n").filter(l => l.trim());
  // the model sometimes writes more than 6 bullets; the prompt asks for the most important first, so keep those
  if (lines.length > MAX_BULLETS && lines.every(l => /^\s*[-*•]\s/.test(l))) body = lines.slice(0, MAX_BULLETS).join("\n");
  return {
    pin: clip(s.pin.replace(/\s+/g, " ").trim(), 60),
    title: clip(s.title.replace(/\s+/g, " ").trim(), 120),
    body,
  };
}

// Last resort: cut at the last bullet/line or sentence end that fits, else at a word, so the text stays <= cap.
export function truncateAtBoundary(text, cap = TOPIC_CAP) {
  text = tidy(text);
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const nl = head.lastIndexOf("\n");
  const sent = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.endsWith(".") ? cap - 1 : -1);
  const cut = Math.max(nl, sent >= 0 ? sent + 1 : -1);
  if (cut >= cap * 0.5) return head.slice(0, cut).trim();
  const sp = head.lastIndexOf(" ", cap - 1);
  return head.slice(0, sp > 0 ? sp : cap - 1).trimEnd() + "…";
}

// Word overlap between a chat and a topic (name + summary): a deterministic last check when the model picked a
// topic but both yes/no confirmations said no. Shared words alone are not enough (a kitchen-cabinet chat shares
// "stud finder" and "brackets" with a garage-shelves topic), so at least one shared word must be an ANCHOR: a token
// with a digit ("1099", "2x4s", "16") or a name written with a capital letter in both texts ("Dana", "Shinjuku").
// Weekday and month names are not anchors (too common). Measured on test/fixtures/match-suite.json.
const STOPWORDS = new Set(("that this with have from your what when will would about there their they them then than just also into only " +
  "some more like make need needs want okay sure yeah good great thanks thank does done dont doesnt it's that's here been being were very much " +
  "each other these those which while should could before after today tomorrow yesterday week next last right maybe really thing things " +
  "know think going something user grok decision todo").split(" "));
const CALENDAR = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "));
const stem = w => w.replace(/'s$/, "").replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");
export function topicWords(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().match(/[a-z0-9$]+/g) || []) {
    if (/\d/.test(w)) { if (w.length >= 2) out.add(w); continue; }
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}
function capitalized(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/\b([A-Z][a-z][A-Za-z']*)/g)) {
    const w = stem(m[1].toLowerCase());
    if (!CALENDAR.has(w) && w !== "user" && w !== "grok") out.add(w);
  }
  return out;
}
export const MATCH_MIN_SHARED = 2, MATCH_MIN_ANCHORS = 1, MATCH_MIN_SHARED_ANY = 1;
// -> {shared: n, anchors: n} (counts only; the words themselves come from chat text and are never logged)
export function overlap(transcript, topic) {
  const tText = `${topic.pinTitle}\n${topic.page1?.body || ""}`;
  const tw = topicWords(tText), cw = topicWords(transcript);
  const capT = capitalized(tText), capC = capitalized(transcript);
  let shared = 0, anchors = 0;
  for (const w of tw) if (cw.has(w)) { shared++; if (/\d/.test(w) || (capT.has(w) && capC.has(w))) anchors++; }
  return { shared, anchors };
}
export const sharedWords = (transcript, topic) => overlap(transcript, topic).shared;

export function topicGist(body, n = 120) {
  const line = String(body || "").split("\n").map(l => l.replace(/^\s*[-*•]\s*/, "").trim()).find(Boolean) || "";
  return clip(line, n);
}

/* ---------- number / time guardrail ----------
 * A 2B model sometimes "completes" facts: "leave by 11" became "leave by 11pm". Every number and every am/pm time in
 * a summary must be supported by its source text (the transcript, plus the current summary for a merge):
 *   1. a time whose number was said but whose am/pm was not ("11pm" from "by 11") loses the am/pm (deterministic);
 *   2. other unsupported numbers: the model is asked once to remove them;
 *   3. still unsupported: the sentence / bullet that holds them is dropped (never the whole summary).
 * Numbers in the source may be written as words ("forty dollars", "May first", "ten by ten").
 */
const NUM_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, dozen: 12, noon: 12, midnight: 12, half: 0.5 };
const ORD_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
  twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MERIDIEM = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/gi;
const WORD_MERIDIEM = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:o'?clock\s*)?(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/gi;
const PART_OF_DAY = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(?:o'?clock\s*)?(in the morning|in the afternoon|in the evening|at night|tonight|this morning|this evening)\b/gi;
const mer = m => (/^a/i.test(m) ? "am" : "pm");
const toNum = w => (/^\d/.test(w) ? Number(w) : NUM_WORDS[w.toLowerCase()]);
// canonical numbers in a text: digits ("45,000" -> 45000, "1st" -> 1, "2x4s" -> 2, 4, "11:30" -> 11, 30) and number words
export function numbersIn(text) {
  const out = new Set();
  const t = String(text || "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) out.add(String(Number(m[0])));
  const lower = t.toLowerCase();
  for (const m of lower.matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g))
    out.add(String(TENS[m[1]] + (NUM_WORDS[m[2]] ?? ORD_WORDS[m[2]])));
  for (const m of lower.matchAll(/\b[a-z]+\b/g)) {
    const w = m[0];
    if (w in NUM_WORDS) out.add(String(NUM_WORDS[w])); else if (w in ORD_WORDS) out.add(String(ORD_WORDS[w]));
  }
  if (/\bnoon\b/.test(lower) || /\bmidnight\b/.test(lower)) out.add("12");
  return out;
}
// canonical am/pm times in a text: "11pm", "11:30am", "eleven p.m.", "7 in the evening", "noon"
export function timesIn(text) {
  const out = new Set();
  const t = String(text || "");
  for (const m of t.matchAll(MERIDIEM)) out.add(`${Number(m[1])}${m[2] ? ":" + m[2] : ""}${mer(m[3])}`);
  for (const m of t.matchAll(WORD_MERIDIEM)) out.add(`${toNum(m[1])}${mer(m[2])}`);
  for (const m of t.matchAll(PART_OF_DAY)) out.add(`${toNum(m[1])}${m[2] ? ":" + m[2] : ""}${/morning/i.test(m[3]) ? "am" : "pm"}`);
  if (/\bnoon\b/i.test(t)) out.add("12pm");
  if (/\bmidnight\b/i.test(t)) out.add("12am");
  return out;
}
// -> {body, checked, meridiemFixed, unsupported: [tokens]} (tokens are numbers/times only)
export function checkNumbers(body, source) {
  const srcNums = numbersIn(source), srcTimes = timesIn(source);
  let meridiemFixed = 0;
  // 1) "11pm" when only "11" was said -> "11"
  body = String(body).replace(MERIDIEM, (all, h, mm, m, at, str) => {
    const canon = `${Number(h)}${mm ? ":" + mm : ""}${mer(m)}`;
    if (srcTimes.has(canon) || (!mm && srcTimes.has(`${Number(h)}:00${mer(m)}`))) return all;
    if (srcNums.has(String(Number(h))) && (!mm || srcNums.has(String(Number(mm))))) {
      meridiemFixed++;
      // "at 9am. Next" -> "at 9. Next": the final dot of "am." also ended the sentence
      const endsSentence = all.endsWith(".") && /^(\s+[A-Z(-]|\s*$)/.test(str.slice(at + all.length).split("\n")[0] || "");
      return `${h}${mm ? ":" + mm : ""}${endsSentence ? "." : ""}`;
    }
    return all;
  });
  const unsupported = [];
  let checked = 0;
  // tokens are reported as written in the summary ("50,000", "7:30"), so dropUnsupported can find them again
  for (const m of body.matchAll(/\d{1,3}(?:,\d{3})+(?!\d)|\d+(?:\.\d+)?/g)) {
    checked++;
    const n = String(Number(m[0].replace(/,/g, "")));
    if (!srcNums.has(n) && !unsupported.includes(m[0])) unsupported.push(m[0]);
  }
  for (const m of body.matchAll(MERIDIEM)) {
    const canon = `${Number(m[1])}${m[2] ? ":" + m[2] : ""}${mer(m[3])}`;
    const tok = `${m[1]}${m[2] ? ":" + m[2] : ""}`;
    if (!srcTimes.has(canon) && !unsupported.includes(tok)) unsupported.push(tok);
  }
  return { body, checked, meridiemFixed, unsupported };
}
// drop the sentences / bullets that contain an unsupported token; never returns an empty body
export function dropUnsupported(body, tokens) {
  if (!tokens.length) return { body, dropped: 0 };
  const bad = piece => tokens.some(tok => new RegExp(`(^|[^0-9.])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(piece));
  let dropped = 0;
  const lines = String(body).split("\n").map(line => {
    if (!bad(line)) return line;
    const parts = line.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)\s*/g) || [line];
    const kept = parts.filter(pt => { if (bad(pt)) { dropped++; return false; } return true; }).join("").trim();
    return /^[-*•]?\s*$/.test(kept) ? null : (line.match(/^\s*[-*•]\s*/) && !/^\s*[-*•]/.test(kept) ? "- " + kept : kept);
  }).filter(l => l !== null);
  const out = tidy(lines.join("\n"));
  return out.length >= 10 ? { body: out, dropped } : { body, dropped: 0, keptAll: true };
}
export const NUMBER_FIX = toks =>
  `These numbers or times in the summary are NOT in the conversation: ${toks.join(", ")}. ` +
  "Rewrite the summary without them (remove them, or the detail they belong to). Keep everything else as it is. Do not add anything.";

// Model operations on top of one chat-completion function. chat({system, user, schema, maxTokens}) -> parsed JSON.
// Kept separate from llama.cpp so tests can script the model's answers.
export function createModelOps(chat, { cap = TOPIC_CAP, log = () => {} } = {}) {
  // cap enforcement: re-ask once with stricter wording, then cut at a boundary as a last resort
  async function capped(body, what) {
    body = dedupeText(body);
    const info = { firstLength: body.length, reasked: false, truncated: false };
    if (body.length > cap) {
      info.reasked = true;
      const again = await chat({ system: COMPACT_PROMPT, user: `${SHORTEN(body.length, Math.round(cap * 0.8))}\n\nSUMMARY:\n${body}`, schema: BODY_SCHEMA, maxTokens: 700 });
      const b2 = dedupeText(String(again?.body || ""));
      if (b2.length >= 10 && b2.length < body.length) body = b2;
    }
    if (body.length > cap) { body = truncateAtBoundary(body, cap); info.truncated = true; }
    info.length = body.length;
    log("info", "cap", { what, ...info });
    return { body, ...info };
  }
  // number/time guardrail (see checkNumbers): deterministic am/pm fix, one re-ask, then drop what is still unsupported
  async function guarded(body, source, what) {
    let c = checkNumbers(dedupeText(body), source);
    const info = { checked: c.checked, meridiemFixed: c.meridiemFixed, unsupported: c.unsupported.length, numbersReasked: false, dropped: 0 };
    body = c.body;
    if (c.unsupported.length) {
      info.numbersReasked = true;
      const again = await chat({ system: COMPACT_PROMPT, user: `${NUMBER_FIX(c.unsupported)}\n\nSUMMARY:\n${body}`, schema: BODY_SCHEMA, maxTokens: 700 });
      const b2 = String(again?.body || "").trim();
      if (b2.length >= 10) { const c2 = checkNumbers(dedupeText(b2), source); info.meridiemFixed += c2.meridiemFixed; body = c2.body; c = c2; }
      if (c.unsupported.length) { const d = dropUnsupported(body, c.unsupported); body = d.body; info.dropped = d.dropped; info.flagged = d.keptAll ? c.unsupported.length : 0; }
    }
    if (info.meridiemFixed || info.unsupported) log("info", "numbers guard", { what, ...info });
    return { body, numbers: info };
  }
  // after the cap re-ask (which only sees the summary): deterministic part only
  function recheck(capInfo, source) {
    const c = checkNumbers(capInfo.body, source);
    let body = c.body, dropped = 0;
    if (c.unsupported.length) { const d = dropUnsupported(body, c.unsupported); body = d.body; dropped = d.dropped; }
    return { ...capInfo, body, length: body.length, numbersAfterCap: c.meridiemFixed + dropped };
  }
  return {
    chat,
    // -> {topic: "<exact existing name>" | "NEW"}
    async match(topics, transcript) {
      const names = [...new Set(topics.map(t => t.pinTitle))];
      if (!names.length) return { topic: "NEW" };
      const list = topics.map(t => `- ${t.pinTitle}: ${topicGist(t.page1?.body)}`).join("\n");
      const r = await chat({ system: MATCH_PROMPT, user: `EXISTING TOPICS:\n${list}\n\nNEW CHAT TRANSCRIPT:\n${transcript}\n\nFirst write the chat's subject in a few words, then pick the existing topic with the same subject, or NEW.`, schema: matchSchema(names), maxTokens: 80 });
      const topic = r?.topic;
      if (topic !== "NEW" && !names.includes(topic)) throw new PollerError("summarizer", "topic match: answer outside the allowed list");
      if (topic === "NEW") return { topic, confirmed: null };
      const t = topics.find(x => x.pinTitle === topic);
      // 0) the chat must share at least one distinctive word with the pick: the yes/no checks below can be wrong on
      //    their own (a car-service chat was once "confirmed" for a bike podcast with zero words in common)
      // 1) subject vs name + first line; 2) the chat itself vs name + summary; 3) anchored word overlap.
      // Each step can only accept the model's own pick; anything else ends as NEW.
      const ov = topics.map(x => ({ name: x.pinTitle, ...overlap(transcript, x) }));
      const mine = ov.find(x => x.name === topic);
      if (mine.shared >= MATCH_MIN_SHARED_ANY) {
        const ask = async (system, user) => (await chat({ system, user, schema: confirmSchema, maxTokens: 20 }))?.answer === "yes";
        if (await ask(CONFIRM_PROMPT, `A: ${clip(String(r.subject || ""), 80)}\nB: ${topic} (${topicGist(t.page1?.body)})\n\nDoes A belong in note B?`)) return { topic, confirmed: true };
        if (t.page1?.body && await ask(CONTEXT_PROMPT, `NOTE "${topic}":\n${clip(String(t.page1.body), 400)}\n\nNEW CHAT:\n${clip(transcript, 800)}\n\nDoes the new chat continue this note?`)) return { topic, confirmed: true, by: "context" };
        // >= 1 anchor AND >= 1 ordinary shared word: a place name alone ("Maple Street") is not enough
        if (mine.shared >= MATCH_MIN_SHARED && mine.anchors >= MATCH_MIN_ANCHORS && mine.shared > mine.anchors && ov.every(x => x.name === topic || x.shared < mine.shared)) {
          log("info", "match accepted by anchored word overlap", { shared: mine.shared, anchors: mine.anchors });
          return { topic, confirmed: true, by: "overlap" };
        }
      }
      log("info", "match rejected by confirmation", { rejected: topic });
      return { topic: "NEW", confirmed: false, rejected: topic };
    },
    // -> {pin, title, body (<= cap), ...capInfo}
    async summarizeNew(transcript) {
      const r = await chat({ system: SYSTEM_PROMPT, user: `Transcript:\n${transcript}`, schema: SUMMARY_SCHEMA, maxTokens: 700 });
      const bad = validateSummary(r);
      if (bad) throw new PollerError("summarizer", `model output fails schema: ${bad}`);
      const s = cleanSummary(r);
      const g = await guarded(s.body, transcript, "new");
      const c = recheck(await capped(g.body, "new"), transcript);
      return { ...s, ...c, body: c.body, numbers: g.numbers };
    },
    // -> {body (<= cap), ...capInfo}
    async merge(topicName, current, transcript) {
      const r = await chat({ system: MERGE_PROMPT, user: `TOPIC: ${topicName}\n\nCURRENT SUMMARY:\n${current}\n\nNEW CONVERSATION:\n${transcript}\n\nWrite the updated summary of the whole topic (at most ${cap} characters).`, schema: BODY_SCHEMA, maxTokens: 1000 });
      if (typeof r?.body !== "string" || !r.body.trim()) throw new PollerError("summarizer", "merge: model output has no body");
      const src = `${current}\n${transcript}`;
      const g = await guarded(r.body, src, "merge");
      return { ...recheck(await capped(g.body, "merge"), src), numbers: g.numbers };
    },
    // -> {body (<= cap), ...capInfo}
    async compact(topicName, current, target = 1000) {
      const r = await chat({ system: COMPACT_PROMPT, user: `TOPIC: ${topicName}\n\nRewrite this summary in about ${target} characters (never more than ${cap}).\n\nSUMMARY:\n${current}`, schema: BODY_SCHEMA, maxTokens: 700 });
      if (typeof r?.body !== "string" || !r.body.trim()) throw new PollerError("summarizer", "compact: model output has no body");
      const g = await guarded(r.body, current, "compact");
      return { ...recheck(await capped(g.body, "compact"), current), numbers: g.numbers };
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
export function memAvailableMb() {
  try { return Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))[1]) / 1024; } catch { return Infinity; }
}
function procMem(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const g = k => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(st) || [0, 0])[1]) / 1024;
    return { rssMb: Math.round(g("VmRSS")), peakMb: Math.round(g("VmHWM")) };
  } catch { return null; }
}

// llama-server never needs the secrets: strip them from its environment
function childEnv(libDir) {
  const { GROK_COOKIE, INBOX_GITHUB_TOKEN, ...rest } = process.env;
  return { ...rest, LD_LIBRARY_PATH: libDir };
}

// {"body": "....  (cut off by max_tokens) -> {body: "...."}; the cap logic then shortens or truncates it
export function salvageBody(content) {
  const m = /^\s*\{\s*"body"\s*:\s*"((?:[^"\\]|\\.)*)/s.exec(String(content));
  if (!m) return null;
  try { return { body: JSON.parse(`"${m[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "")}"`) }; } catch { return null; }
}

export function createLlamaSummarizer(cfg, log = () => {}) {
  // Start llama-server with this context size, run fn(ops), always stop the server afterwards.
  async function withModel(ctx, fn) {
    if (memAvailableMb() < cfg.minFreeMb) throw new PollerError("summarizer", `only ${Math.round(memAvailableMb())} MB RAM free (< ${cfg.minFreeMb}); will retry`);
    const port = cfg.llamaPort || await freePort();
    const t0 = Date.now();
    const srv = spawn(path.join(cfg.llamaDir, "llama-server"), [
      "-m", cfg.llamaModel, "--host", "127.0.0.1", "--port", String(port), "-t", String(cfg.llamaThreads),
      "-c", String(ctx), "--no-repack", "--no-mmproj", "-np", "1",
    ], { env: childEnv(cfg.llamaDir), stdio: "ignore" }); // server output can echo prompts: discard
    let exited = false; srv.on("exit", () => { exited = true; });
    const stop = async () => {
      if (exited) return;
      srv.kill("SIGTERM");
      for (let i = 0; i < 100 && !exited; i++) await sleep(100);
      if (!exited) srv.kill("SIGKILL");
    };
    const stats = { ctx, calls: 0, promptTokens: 0, outTokens: 0 };
    try {
      const base = `http://127.0.0.1:${port}`;
      let up = false;
      for (let i = 0; i < 240 && !exited; i++) {
        try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break; } } catch {}
        await sleep(500);
      }
      if (!up) throw new PollerError("summarizer", exited ? "llama-server exited during startup" : "llama-server did not become healthy in 120 s");
      stats.loadMs = Date.now() - t0;
      const chat = async ({ system, user, schema, maxTokens = 700 }) => {
        const r = await fetch(`${base}/v1/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(600_000),
          body: JSON.stringify({
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            temperature: 0.2, max_tokens: maxTokens,
            // a 2B model can fall into repeating the same sentence until max_tokens; a mild penalty stops that
            repeat_penalty: 1.1, repeat_last_n: 256,
            response_format: { type: "json_schema", json_schema: { name: "out", schema } },
            chat_template_kwargs: { enable_thinking: false },
          }),
        });
        if (!r.ok) throw new PollerError("summarizer", `llama-server HTTP ${r.status}`);
        const data = await r.json();
        stats.calls++; stats.promptTokens += data.timings?.prompt_n ?? 0; stats.outTokens += data.timings?.predicted_n ?? 0;
        const content = data.choices?.[0]?.message?.content ?? "";
        try { return JSON.parse(content); } catch {}
        const partial = salvageBody(content); // ran out of tokens inside {"body": "...": keep what was written
        if (partial) { stats.salvaged = (stats.salvaged || 0) + 1; return partial; }
        throw new PollerError("summarizer", "model output is not valid JSON");
      };
      const result = await fn(createModelOps(chat, { log }));
      Object.assign(stats, procMem(srv.pid) || {}, { totalMs: Date.now() - t0 });
      log("info", "model session", stats);
      return { result, stats };
    } finally { await stop(); }
  }
  return {
    withModel,
    // one-off summary of a transcript (used by --summarize-file)
    async summarize(transcript) {
      const fit = fitTranscript(transcript);
      const { result, stats } = await withModel(fit.ctx, ops => ops.summarizeNew(fit.text));
      return { summary: { pin: result.pin, title: result.title, body: result.body }, stats: { ...stats, truncated: fit.truncated } };
    },
  };
}

/* ------------------------------------------------------------------ */
/* inbox: GitHub contents API on post-it-board@inbox                   */
/* ------------------------------------------------------------------ */
export function commandFileName(cKey, lastMsgTime, op, retry = 0) {
  return `auto-${cKey}-${fmtUtcCompact(lastMsgTime)}-${op}${retry ? `-r${retry}` : ""}.json`;
}

export function createGithubInbox({ token, repo, branch, api = "https://api.github.com", fetchFn = fetch, retries = 4, backoffMs = 2000 }) {
  if (!token) throw new PollerError("push", "INBOX_GITHUB_TOKEN is not set");
  const headers = {
    authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
    "user-agent": "post-it-poller",
  };
  const url = p => `${api}/repos/${repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}`;
  async function call(method, p, body) {
    let res;
    try {
      res = await fetchFn(method === "GET" ? `${url(p)}?ref=${encodeURIComponent(branch)}` : url(p),
        { method, headers: body ? { ...headers, "content-type": "application/json" } : headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw new PollerError("push", `GitHub ${method} ${p}: ${e.cause?.code || "fetch failed"}`); }
    return res;
  }
  async function getJson(p) {
    const res = await call("GET", p);
    if (res.status === 404) return null;
    if (!res.ok) throw new PollerError("push", `GitHub GET ${p}: HTTP ${res.status}`, { status: res.status });
    const d = await res.json();
    try { return JSON.parse(Buffer.from(d.content || "", "base64").toString("utf8")); } catch { return { status: "unreadable" }; }
  }
  return {
    kind: "github",
    getResult: name => getJson(`inbox/results/${name}`),
    async commandExists(name) { return (await getJson(`inbox/${name}`)) !== null; },
    // push-if-absent (docs §4.3). Returns {state: "processed", result} | {state: "waiting"} | {state: "pushed", commit}
    async pushIfAbsent(name, cmd) {
      for (let attempt = 0; ; attempt++) {
        const result = await this.getResult(name);
        if (result) return { state: "processed", result };
        if (await this.commandExists(name)) return { state: "waiting" };
        const res = await call("PUT", `inbox/${name}`, {
          message: `inbox: poller ${cmd.op} (${name})`, branch,
          content: Buffer.from(JSON.stringify(cmd, null, 2) + "\n").toString("base64"),
        });
        if (res.ok) { const d = await res.json().catch(() => ({})); return { state: "pushed", commit: d.commit?.sha || null }; }
        if ((res.status === 409 || res.status === 422) && attempt < retries) { await sleep(backoffMs * 2 ** attempt); continue; }
        if (res.status === 401 || res.status === 403) throw new PollerError("push", `GitHub PUT: HTTP ${res.status} (INBOX_GITHUB_TOKEN invalid, expired or lacks Contents: write)`, { status: res.status });
        throw new PollerError("push", `GitHub PUT inbox/${name}: HTTP ${res.status}`, { status: res.status });
      }
    },
  };
}

// --dry-run: write the command locally and fake an "ok" result so the state machine can be exercised
export function createDryRunInbox(dir) {
  const inboxDir = path.join(dir, "inbox"), resDir = path.join(inboxDir, "results");
  return {
    kind: "dry-run",
    async getResult(name) { return loadState(path.join(resDir, name)); },
    async commandExists(name) { return fs.existsSync(path.join(inboxDir, name)); },
    async pushIfAbsent(name, cmd) {
      const r = await this.getResult(name);
      if (r) return { state: "processed", result: r };
      writeJsonAtomic(path.join(inboxDir, name), cmd);
      writeJsonAtomic(path.join(resDir, name), {
        status: "ok", op: cmd.op, input: cmd, dryRun: true, message: "dry run: not pushed",
        matched: { pinTitle: cmd.pin }, pageNumber: cmd.pageNumber || 1, date: cmd.date, processedAt: new Date().toISOString(),
      });
      return { state: "pushed", commit: null };
    },
  };
}

/* ------------------------------------------------------------------ */
/* board: public, read-only topic list (Supabase anon key)             */
/* ------------------------------------------------------------------ */
const exactCI = s => String(s).replace(/[\ufe0e\ufe0f]/g, "").trim().replace(/\s+/g, " ").toLowerCase(); // as post.mjs
export function jwtRole(key) {
  try { return JSON.parse(Buffer.from(String(key).split(".")[1], "base64url").toString("utf8")).role || null; } catch { return null; }
}
// URL + anon key: BOARD_SUPABASE_URL/BOARD_SUPABASE_ANON_KEY, else parsed from the site's public config.js
export async function loadBoardConfig(env = process.env, fetchFn = fetch) {
  let url = env.BOARD_SUPABASE_URL, key = env.BOARD_SUPABASE_ANON_KEY;
  if (!url || !key) {
    const src = env.BOARD_CONFIG || "https://mogesjohnson.github.io/post-it-board/config.js";
    let text;
    try { text = /^https?:/.test(src) ? await (await fetchFn(src)).text() : fs.readFileSync(src, "utf8"); }
    catch (e) { throw new PollerError("board", `cannot read board config ${src}: ${e.cause?.code || e.code || e.message}`); }
    url ||= /SUPABASE_URL:\s*["']([^"']+)["']/.exec(text)?.[1];
    key ||= /SUPABASE_ANON_KEY:\s*["']([^"']+)["']/.exec(text)?.[1];
  }
  if (!url || !key) throw new PollerError("board", "board Supabase URL / anon key not found");
  // read-only by design: never accept a service_role (or any non-anon) key here
  if (!String(key).startsWith("sb_publishable_") && jwtRole(key) !== "anon") throw new PollerError("board", "board key is not the public anon key; refusing to use it");
  return { url: url.replace(/\/+$/, ""), anonKey: key };
}
const latest = (...ts) => ts.filter(Boolean).sort().at(-1) || null; // ISO strings compare lexically (same offset format)
const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.created_at).localeCompare(String(b.created_at));
// rows: pins with day:days(board_date) and pages(...) embedded -> topics, most recently updated first
export function topicsFromRows(rows) {
  return rows.map(p => {
    const pages = (p.pages || []).slice().sort(byPos);
    const pg = pages[0];
    const updatedAt = latest(p.updated_at, p.created_at, ...pages.flatMap(x => [x.updated_at, x.created_at]));
    return {
      pinId: p.id, pinTitle: p.title, date: p.day?.board_date || null, color: p.color || null, updatedAt, pageCount: pages.length,
      page1: pg ? { id: pg.id, title: pg.title ?? null, body: pg.body ?? "", updatedAt: latest(pg.updated_at, pg.created_at) } : null,
    };
  }).sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0) || String(a.pinTitle).localeCompare(String(b.pinTitle)));
}
export function createBoardReader({ env = process.env, fetchFn = fetch, config } = {}) {
  let conf = config || null;
  return {
    async listTopics() {
      conf ||= await loadBoardConfig(env, fetchFn);
      const q = "pins?select=id,title,color,created_at,updated_at,day:days(board_date),pages(id,title,body,position,created_at,updated_at)";
      let res;
      try { res = await fetchFn(`${conf.url}/rest/v1/${q}`, { headers: { apikey: conf.anonKey, authorization: `Bearer ${conf.anonKey}`, accept: "application/json" } }); }
      catch (e) { throw new PollerError("board", `board read: ${e.cause?.code || "fetch failed"}`); }
      if (!res.ok) throw new PollerError("board", `board read: HTTP ${res.status}`);
      const rows = await res.json().catch(() => null);
      if (!Array.isArray(rows)) throw new PollerError("board", "board read: unexpected response");
      return topicsFromRows(rows);
    },
  };
}
export const isExcluded = (cfg, t) => (cfg.topicsExclude || []).some(x => exactCI(x) === exactCI(t.pinTitle));

/* ------------------------------------------------------------------ */
/* model lock: one llama-server user at a time (loop vs --compact)     */
/* ------------------------------------------------------------------ */
// Returns a release function, or null when another live process holds the lock. Stale locks are taken over.
export function tryLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = 0; try { pid = Number(fs.readFileSync(file, "utf8")); } catch {}
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (e2) { alive = e2.code === "EPERM"; } }
      if (alive) return null;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */
export const PAGE_TITLE = "Summary";
// NEW topic: a new pin whose page 1 is the topic paper
export function addCommand({ date, pin, body, title = PAGE_TITLE }) {
  return { op: "add", date, pin: clip(pin, LIMITS.pin), title, body: clip(body, LIMITS.body) };
}
// existing topic: replace page 1 of that pin (exact day + exact pin title, as post.mjs requires for edits)
export function editTopicCommand(topic, body) {
  return { op: "edit", target: "page", date: topic.date, pin: topic.pinTitle, pageNumber: topic.pageNumber || 1, body: clip(body, LIMITS.body) };
}

/* ------------------------------------------------------------------ */
/* the poller                                                          */
/* ------------------------------------------------------------------ */
export function createPoller({ cfg, reader, summarizer, inbox, board, log = () => {}, now = Date.now, statePath, healthPath }) {
  statePath ??= path.join(cfg.stateDir, "state.json");
  healthPath ??= path.join(cfg.stateDir, "health.json");
  const modelLock = path.join(cfg.home, "model.lock");
  const health = makeHealth(healthPath, now);
  let state = loadState(statePath);
  if (!state) {
    const since = cfg.since ? new Date(cfg.since).toISOString() : new Date(now()).toISOString();
    state = { version: 2, firstRunAt: new Date(now()).toISOString(), since, conversations: {} };
    log("info", "first run: no backfill", { since });
  } else if (cfg.since) {
    state.since = new Date(cfg.since).toISOString();
    log("info", "since overridden", { since: state.since });
  }
  const cache = new Map(); // conversationId -> messages (memory only, never persisted)
  const save = () => saveState(statePath, state);
  save();

  const sameTopic = (a, b) => a && b && a.date === b.date && exactCI(a.pinTitle) === exactCI(b.pinTitle);
  const topicBusy = (t, self) => Object.values(state.conversations).some(s => s !== self && s.pending && sameTopic(s.pending.topic, t));

  async function checkPending(id, st) {
    const p = st.pending;
    let r = await inbox.getResult(p.file);
    if (!r) {
      if (!(await inbox.commandExists(p.file))) {
        r = await inbox.getResult(p.file); // processed between the two reads?
        if (!r) {
          st.status = "needs_attention"; st.lastResult = { file: p.file, status: "missing", at: new Date(now()).toISOString() };
          log("warn", "command removed without a result", { conv: st.convKey, file: p.file });
          st.pending = null; return;
        }
      } else {
        if (now() - ms(p.pushedAt) > 10 * 60_000 && !p.alerted) { p.alerted = true; log("warn", "no result after 10 min", { conv: st.convKey, file: p.file }); }
        return;
      }
    }
    st.lastResult = { file: p.file, status: r.status, op: r.op, message: r.message, processedAt: r.processedAt || null };
    log("info", "result", { conv: st.convKey, file: p.file, status: r.status, op: r.op });
    if (r.status === "ok" || r.status === "skipped_duplicate") {
      st.board = { date: r.date || p.cmd.date, pinTitle: r.matched?.pinTitle || p.cmd.pin, pageNumber: (p.cmd.op === "edit" ? p.cmd.pageNumber : r.pageNumber) || 1 };
      st.lastPostedMsgTime = p.lastTs; st.status = "posted";
    } else if (r.status === "skipped_not_found" && p.op === "edit") {
      st.board = null; st.status = "quiet"; // topic gone: the next poll matches again (a NEW topic gets an -add name)
    } else if (r.status === "error") {
      if (!p.alertedError) { p.alertedError = true; log("warn", "inbox Action error; waiting for a re-run", { conv: st.convKey, file: p.file }); }
      return; // keep pending
    } else {
      st.status = "needs_attention";
      log("warn", "needs attention", { conv: st.convKey, file: p.file, status: r.status });
    }
    st.pending = null;
  }

  // Decide the topic and write the command, inside one llama-server session.
  async function writeTopic(st, todo, newMsgs) {
    const topics = (await board.listTopics()).filter(t => !isExcluded(cfg, t));
    let target = st.board ? topics.find(t => sameTopic(t, st.board)) || null : null;
    if (st.board && !target) { log("info", "topic no longer on the board; matching again", { conv: st.convKey }); st.board = null; }
    if (target && topicBusy(target, st)) return { kind: "busy" };
    const candidates = topics.slice(0, cfg.maxTopics);
    const listChars = candidates.reduce((n, t) => n + t.pinTitle.length + 130, 0);
    const curChars = Math.max(0, ...candidates.map(t => (t.page1?.body || "").length));
    const fit = fitTranscript(formatTranscript(target ? newMsgs : todo), MAX_CTX, Math.max(listChars, curChars) + 400);
    const { result, stats } = await summarizer.withModel(fit.ctx, async ops => {
      let how = target ? "resume" : "new";
      if (!target && candidates.length) {
        const m = await ops.match(candidates, fit.text);
        log("info", "topic match", { conv: st.convKey, candidates: candidates.length, matched: m.topic !== "NEW" });
        if (m.topic !== "NEW") { target = candidates.find(t => t.pinTitle === m.topic); how = "match"; }
      }
      let fresh = null;
      if (!target) {
        fresh = await ops.summarizeNew(fit.text);
        const pin = cfg.pinOverride || fresh.pin;
        const same = candidates.find(t => norm(t.pinTitle) === norm(pin)); // the name exists already: merge into it
        if (!same) return { how, cmd: addCommand({ date: nyDate(todo[0].createTime), pin, body: fresh.body }), info: fresh };
        target = same; how = "same-name";
      }
      if (topicBusy(target, st)) return { busy: true };
      if (!target.page1) { // pin without pages: its first page becomes the topic paper
        fresh ||= await ops.summarizeNew(fit.text);
        return { how, cmd: addCommand({ date: target.date, pin: target.pinTitle, body: fresh.body }), info: fresh };
      }
      const mg = await ops.merge(target.pinTitle, target.page1.body, fit.text);
      return { how, cmd: editTopicCommand(target, mg.body), info: mg };
    });
    if (result.busy) return { kind: "busy" };
    return { kind: "write", ...result, stats, truncatedTranscript: fit.truncated };
  }

  async function handle(conv, nowMs) {
    const st = state.conversations[conv.id] ??= { convKey: convKey(conv.id), status: "active", retry: 0, lastPostedMsgTime: null, board: null };
    if (st.pending) { await checkPending(conv.id, st); if (st.pending) return "pending"; }
    if (st.status === "opted_out" && st.lastLoadedModify === conv.modifyTime) return "opted_out";

    const modifyMs = ms(conv.modifyTime);
    // cheap pre-check: still being modified -> no need to load bodies yet
    if (nowMs - modifyMs < cfg.quietMinutes * 60_000 && modifyMs <= nowMs + 60_000) { st.status = "active"; return "active"; }
    // unchanged since we last loaded it and nothing unposted -> skip without a request
    if (st.lastLoadedModify === conv.modifyTime && st.lastSeenTs && st.lastPostedMsgTime && ms(st.lastSeenTs) <= ms(st.lastPostedMsgTime)) return "up_to_date";

    if (!cache.has(conv.id) || st.lastLoadedModify !== conv.modifyTime) {
      cache.set(conv.id, await reader.getMessages(conv.id)); // costly load only when changed
      st.lastLoadedModify = conv.modifyTime;
      log("info", "loaded", { conv: st.convKey, messages: cache.get(conv.id).length });
    }
    const msgs = cache.get(conv.id);
    if (!msgs.length) return "empty";
    const last = msgs[msgs.length - 1];
    if (st.lastPostedMsgTime && ms(last.createTime) <= ms(st.lastPostedMsgTime)) { st.lastSeenTs = last.createTime; return "up_to_date"; }
    if (st.status === "needs_attention" && st.lastSeenTs === last.createTime) return "needs_attention";
    if (st.lastSeenTs !== last.createTime) { st.lastSeenTs = last.createTime; st.firstSeenAt = new Date(nowMs).toISOString(); if (st.status !== "posted") st.status = "active"; }

    const newestMs = Math.max(...msgs.map(m => ms(m.createTime)));
    const q = quietInfo({ nowMs, newestMs, modifyMs, firstSeenAtMs: ms(st.firstSeenAt), quietMinutes: cfg.quietMinutes });
    if (!q.quiet) return "active";

    if (hasOptOut(msgs)) {
      st.status = "opted_out"; st.lastPostedMsgTime = last.createTime;
      log("info", "opted out", { conv: st.convKey }); return "opted_out";
    }
    const todo = msgs.slice(araPostPoint(msgs));
    // a resumed conversation only adds what came after the last post to its topic
    const newMsgs = st.lastPostedMsgTime ? todo.filter(m => ms(m.createTime) > ms(st.lastPostedMsgTime)) : todo;
    if (!newMsgs.some(m => m.sender === "human") || formatTranscript(newMsgs).length < 40) {
      st.lastPostedMsgTime = last.createTime; st.status = st.board ? "posted" : "skipped_trivial";
      log("info", "nothing substantial to post", { conv: st.convKey, messages: newMsgs.length }); return "trivial";
    }

    // one llama-server user at a time: if --compact holds the model, try again next poll
    const release = tryLock(modelLock);
    if (!release) { log("info", "model busy (compaction?); deferring", { conv: st.convKey }); return "deferred"; }
    let w;
    try {
      st.status = "quiet";
      log("info", "quiet; writing topic", { conv: st.convKey, messages: todo.length, newMessages: newMsgs.length, quietMin: +(q.quietMs / 60000).toFixed(1), method: q.method, resume: !!st.board });
      try { w = await writeTopic(st, todo, newMsgs); }
      catch (e) { throw e instanceof PollerError ? e : new PollerError("summarizer", e.message); }
      if (w.kind === "busy") { log("info", "topic has a command waiting for its result; deferring", { conv: st.convKey }); return "deferred"; }
      const cmd = w.cmd;
      const name = commandFileName(st.convKey, last.createTime, cmd.op, st.retry);
      const pushed = await inbox.pushIfAbsent(name, cmd);
      st.pending = { file: name, lastTs: last.createTime, op: cmd.op, pushedAt: new Date(nowMs).toISOString(), cmd, topic: { date: cmd.date, pinTitle: cmd.pin }, how: w.how };
      st.status = "posting";
      log("info", "pushed", { conv: st.convKey, file: name, op: cmd.op, how: w.how, chars: cmd.body.length, reasked: !!w.info?.reasked, truncated: !!w.info?.truncated, amPmFixed: w.info?.numbers?.meridiemFixed || 0, numbersDropped: w.info?.numbers?.dropped || 0, state: pushed.state, commit: pushed.commit?.slice(0, 7) });
      save();
      if (pushed.state === "processed") await checkPending(conv.id, st);
      return w.how === "new" ? "pushed_new" : "pushed_merge";
    } finally { release(); }
  }

  return {
    get state() { return state; },
    health,
    // one poll cycle. Throws PollerError on reader failures (caller backs off).
    async cycle() {
      const nowMs = now();
      const convs = await reader.listRecentConversations();
      const sinceMs = ms(state.since);
      const voice = convs.filter(c => c.mediaTypes.includes("audio") && ms(c.modifyTime) > sinceMs);
      const counts = {};
      let partError = null;
      for (const c of voice) {
        try { const r = await handle(c, nowMs); counts[r] = (counts[r] || 0) + 1; }
        catch (e) {
          if (!(e instanceof PollerError) || e.kind === "auth" || e.kind === "schema" || e.kind === "network") { save(); throw e; }
          partError = e; // summarizer/board/push problem for one conversation: keep going, report it
          log("error", "conversation failed", { conv: convKey(c.id), kind: e.kind, error: e.message });
        }
      }
      // pending results of conversations that dropped off page 1
      for (const [id, st] of Object.entries(state.conversations)) {
        if (st.pending && !voice.some(c => c.id === id)) { try { await checkPending(id, st); } catch (e) { partError ??= e; } }
      }
      save();
      log("info", "poll", { listed: convs.length, voice: voice.length, ...counts });
      if (partError) { health.fail(partError.kind, partError.message); return { ok: false, error: partError }; }
      health.ok();
      return { ok: true, counts };
    },
    hasPending: () => Object.values(state.conversations).some(s => s.pending),
    // read inbox results only (GitHub), no grok.com request
    async checkAllPending() {
      for (const [id, st] of Object.entries(state.conversations)) if (st.pending) await checkPending(id, st);
      save();
    },
    // manual reset of a needs_attention conversation (bumps retry so the file name changes)
    reset(key) {
      const st = Object.values(state.conversations).find(s => s.convKey === key);
      if (!st) return false;
      st.status = "quiet"; st.pending = null; st.retry = (st.retry || 0) + 1; st.lastSeenTs = null; save();
      return true;
    },
    save,
  };
}

/* ------------------------------------------------------------------ */
/* weekly compaction: --compact                                        */
/* ------------------------------------------------------------------ */
function loopHasPending(file) {
  const s = loadState(file);
  return !!s && Object.values(s.conversations || {}).some(c => c.pending);
}
export function selectForCompaction(topics, cfg, threshold) {
  return topics.filter(t => t.page1 && !isExcluded(cfg, t) && t.page1.body.length > threshold);
}
// Rewrites every topic paper longer than `threshold` to about `target` characters (never over TOPIC_CAP) and
// pushes `edit` commands (or, with dryRun, writes them locally). Holds the model lock for the whole run and
// waits until the loop has no command waiting for a result, so the two never edit the same page at once.
export async function runCompaction({ cfg, board, summarizer, inbox, log = () => {}, dryRun = false, threshold = TOPIC_CAP, target = 1000,
  lockWaitMs = 600_000, pollMs = 5000, resultWaitMs = 300_000, now = Date.now, loopStatePath } = {}) {
  const report = { startedAt: new Date(now()).toISOString(), dryRun, threshold, target, checked: 0, over: 0, compacted: 0, failed: 0, topics: [], skipped: null };
  loopStatePath ??= path.join(cfg.home, "state.json");
  const t0 = now();
  let release;
  while (!(release = tryLock(path.join(cfg.home, "model.lock")))) {
    if (now() - t0 > lockWaitMs) { report.skipped = "model busy: a summary is in progress"; return report; }
    await sleep(pollMs);
  }
  try {
    while (loopHasPending(loopStatePath)) {
      if (now() - t0 > lockWaitMs) { report.skipped = "the poller has an inbox command waiting for its result"; return report; }
      await sleep(pollMs);
    }
    const all = (await board.listTopics()).filter(t => t.page1 && !isExcluded(cfg, t));
    report.checked = all.length;
    const over = selectForCompaction(all, cfg, threshold);
    report.over = over.length;
    if (!over.length) return report;
    const ctx = fitTranscript("", MAX_CTX, Math.max(...over.map(t => t.page1.body.length)) + 600).ctx;
    const { result: rewritten } = await summarizer.withModel(ctx, async ops => {
      const out = [];
      for (const t of over) {
        try { out.push({ t, c: await ops.compact(t.pinTitle, t.page1.body, target) }); }
        catch (e) { out.push({ t, error: e.message }); }
      }
      return out;
    });
    const stamp = fmtUtcCompact(now());
    const waiting = [];
    for (const { t, c, error } of rewritten) {
      const entry = { pin: t.pinTitle, date: t.date, before: t.page1.body.length, after: c?.body.length ?? null, reasked: !!c?.reasked, truncated: !!c?.truncated, status: null, file: null };
      report.topics.push(entry);
      if (error) { entry.status = "error_model"; entry.error = error; report.failed++; continue; }
      if (c.body.length >= t.page1.body.length) { entry.status = "skipped_not_shorter"; continue; }
      const cmd = editTopicCommand(t, c.body);
      entry.file = `compact-${createHash("sha256").update(String(t.pinId)).digest("hex").slice(0, 10)}-${stamp}.json`;
      try {
        const p = await inbox.pushIfAbsent(entry.file, cmd);
        if (dryRun) { entry.status = "dry_run"; report.compacted++; continue; }
        entry.status = p.state === "processed" ? p.result.status : "pushed";
        if (p.state !== "processed") waiting.push(entry);
        else if (p.result.status === "ok") report.compacted++;
      } catch (e) { entry.status = "error_push"; entry.error = e.message; report.failed++; }
    }
    // wait for the inbox Action, so the loop never merges into a page whose compaction isn't applied yet
    const t1 = now();
    while (waiting.length && now() - t1 < resultWaitMs) {
      await sleep(pollMs);
      for (const e of waiting.slice()) {
        const r = await inbox.getResult(e.file).catch(() => null);
        if (!r) continue;
        e.status = r.status; waiting.splice(waiting.indexOf(e), 1);
        if (r.status === "ok") report.compacted++; else report.failed++;
      }
    }
    for (const e of waiting) { e.status = "no_result_yet"; report.failed++; }
    return report;
  } finally {
    release();
    report.finishedAt = new Date(now()).toISOString();
    log("info", "compaction", { dryRun, threshold, checked: report.checked, over: report.over, compacted: report.compacted, failed: report.failed, skipped: report.skipped,
      topics: report.topics.map(t => ({ before: t.before, after: t.after, status: t.status })) });
  }
}
export function formatCompactionReport(r) {
  const lines = [`Compaction ${r.dryRun ? "(dry run) " : ""}${r.startedAt}: threshold ${r.threshold} chars, target ~${r.target}`];
  if (r.skipped) lines.push(`SKIPPED: ${r.skipped}`);
  lines.push(`topics checked: ${r.checked}, over threshold: ${r.over}, compacted: ${r.compacted}, failed: ${r.failed}`);
  for (const t of r.topics) lines.push(`- "${t.pin}" (${t.date}): ${t.before} -> ${t.after ?? "?"} chars, ${t.status}${t.reasked ? ", re-asked" : ""}${t.truncated ? ", truncated" : ""}${t.error ? ` (${t.error})` : ""}`);
  return lines.join("\n");
}

export function backoffSeconds(failures, pollSeconds, maxSeconds = 600, retryAfterSec) {
  const b = Math.min(maxSeconds, pollSeconds * 2 ** Math.max(0, failures - 1));
  return Math.max(b, Math.min(retryAfterSec || 0, 3600));
}

export const maxBackoffFor = (kind, cfg) => (kind === "auth" ? Math.max(cfg.maxBackoffSeconds, cfg.authMaxBackoffSeconds || 0) : cfg.maxBackoffSeconds);
// one loop iteration with health bookkeeping; returns how long to sleep (backoff on failures)
export async function pollOnce(poller, cfg, log = () => {}) {
  try {
    const r = await poller.cycle();
    if (r.ok) return { ok: true, wait: cfg.pollSeconds };
    return { ok: false, kind: r.error.kind, wait: backoffSeconds(poller.health.get().consecutiveFailures, cfg.pollSeconds, maxBackoffFor(r.error.kind, cfg)) };
  } catch (e) {
    const kind = e instanceof PollerError ? e.kind : "network";
    poller.health.fail(kind, e.message);
    const wait = backoffSeconds(poller.health.get().consecutiveFailures, cfg.pollSeconds, maxBackoffFor(kind, cfg), e.retryAfterSec);
    log("error", "poll failed", { kind, error: e.message, consecutiveFailures: poller.health.get().consecutiveFailures, retryInSec: wait });
    return { ok: false, kind, wait };
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); return false; } catch {} }
  } catch {}
  fs.writeFileSync(file, String(process.pid));
  const release = () => { try { if (Number(fs.readFileSync(file, "utf8")) === process.pid) fs.unlinkSync(file); } catch {} };
  process.on("exit", release);
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { release(); process.exit(0); });
  return true;
}

// Secrets file (KEY=VALUE lines, optional quotes). Values are taken literally (cookies contain ; and =).
// Refuses a file that group/others can read. Variables already in the environment win.
export function loadEnvFile(file, env = process.env) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (st.mode & 0o077) throw new PollerError("auth", `${file} must be chmod 600 (it holds secrets)`);
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v.at(-1) === v[0]) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
  return true;
}

async function main(argv) {
  const home0 = process.env.POLLER_HOME || path.join(os.homedir(), ".post-it-poller");
  loadEnvFile(process.env.POLLER_ENV_FILE || path.join(home0, "env"));
  const cfg = loadConfig(process.env, argv);
  const a = cfg.args;
  const log = makeLogger(path.join(cfg.home, "poller.log"), { echo: !a.quiet });

  if (a.health) {
    const h = loadState(path.join(cfg.stateDir, "health.json"));
    const v = healthVerdict(h, Date.now(), Number(a["stale-minutes"]) || Math.max(10, (cfg.maxBackoffSeconds + cfg.pollSeconds) / 60 + 1));
    console.log(JSON.stringify({ ...v, ...(h || {}) }, null, 2));
    process.exit(v.healthy ? 0 : 1);
  }

  if (a["summarize-file"]) {
    const text = fs.readFileSync(a["summarize-file"], "utf8");
    const { summary, stats } = await createLlamaSummarizer(cfg, () => {}).summarize(text);
    console.log(JSON.stringify({ summary, stats, schemaValid: validateSummary(summary) === null }, null, 2));
    return;
  }

  const makeInbox = () => cfg.dryRun ? createDryRunInbox(cfg.stateDir)
    : createGithubInbox({ token: process.env.INBOX_GITHUB_TOKEN, repo: cfg.repo, branch: cfg.branch, api: cfg.githubApi });

  if (a["send-command"]) {
    const cmd = JSON.parse(fs.readFileSync(a["send-command"], "utf8"));
    const name = typeof a.name === "string" ? a.name : `poller-manual-${fmtUtcCompact(Date.now())}-${cmd.op}.json`;
    const inbox = makeInbox();
    const p = await inbox.pushIfAbsent(name, cmd);
    log("info", "manual command", { file: name, op: cmd.op, state: p.state, commit: p.commit?.slice(0, 7) });
    let r = p.result || null;
    for (let i = 0; !r && i < 60; i++) { await sleep(5000); r = await inbox.getResult(name); }
    console.log(JSON.stringify({ file: name, status: r?.status ?? "no result after 5 min", message: r?.message, matched: r?.matched, pageNumber: r?.pageNumber, date: r?.date }, null, 2));
    process.exit(r && !/^error/.test(r.status) ? 0 : 2);
  }

  if (a.compact) {
    // weekly compaction: safe to run while the loop runs (model lock + waits for the loop's pending results)
    const threshold = Number(a.threshold) || cfg.compactThreshold;
    // never aim above ~2/3 of the threshold (default 1500 -> 1000), so a low --threshold also means a short target
    const target = Number(a.target) || Math.min(cfg.compactTarget, Math.floor(threshold * 2 / 3));
    const inbox = cfg.dryRun ? createDryRunInbox(path.join(cfg.home, "dry-run", "compact"))
      : createGithubInbox({ token: process.env.INBOX_GITHUB_TOKEN, repo: cfg.repo, branch: cfg.branch, api: cfg.githubApi });
    const report = await runCompaction({ cfg, board: createBoardReader(), summarizer: createLlamaSummarizer(cfg, () => {}), inbox, log: makeLogger(path.join(cfg.home, "poller.log"), { echo: false }),
      dryRun: cfg.dryRun, threshold, target, lockWaitMs: (Number(a["lock-wait"]) || 600) * 1000 });
    console.log(a.json ? JSON.stringify(report, null, 2) : formatCompactionReport(report));
    process.exit(report.skipped ? 75 : report.failed ? 1 : 0);
  }

  if (!acquireLock(path.join(cfg.home, "poller.lock"))) { console.error("another poller is running (lock held)"); process.exit(3); }
  if (a.reset) {
    const p = createPoller({ cfg, reader: null, summarizer: null, inbox: null, log });
    const ok = p.reset(String(a.reset));
    console.log(ok ? `reset ${a.reset}: status quiet, retry bumped` : `no conversation with convKey ${a.reset}`);
    process.exit(ok ? 0 : 1);
  }
  const reader = cfg.reader === "browser" ? createBrowserReader()
    : createRestReader({ baseUrl: cfg.grokBase, cookie: process.env.GROK_COOKIE, pageSize: cfg.pageSize });
  const poller = createPoller({ cfg, reader, summarizer: createLlamaSummarizer(cfg, log), inbox: makeInbox(), board: createBoardReader(), log });
  log("info", "start", { reader: reader.kind, quietMinutes: cfg.quietMinutes, pollSeconds: cfg.pollSeconds, dryRun: cfg.dryRun, since: poller.state.since, repo: cfg.repo, branch: cfg.branch });

  for (;;) {
    const { wait } = await pollOnce(poller, cfg, log);
    if (a.once) {
      // --wait: poll only the inbox results (GitHub) every 5 s for up to 5 min; grok.com is not called again
      if (a.wait) for (let i = 0; i < 60 && poller.hasPending(); i++) { await sleep(5000); try { await poller.checkAllPending(); } catch (e) { log("error", "result check failed", { kind: e.kind, error: e.message }); } }
      poller.save();
      process.exit(poller.health.get().ok ? 0 : 1);
    }
    await sleep(wait * 1000);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => { console.error(JSON.stringify({ level: "fatal", kind: e.kind, error: e.message })); process.exit(1); });
}
