#!/usr/bin/env node
// Post-it transcript poller (issue #4). Node 18+, no dependencies (built-in fetch).
//
// Watches recent Grok voice conversations (REST, read-only), waits until one has been quiet for
// QUIET_MINUTES, summarizes it with a local llama.cpp model, and pushes one command file to the
// `inbox` branch of mogesjohnson/post-it-board. A conversation that continues later gets an `edit`
// of the same page. Design: docs/transcript-automation.md. Usage: poller/README.md.
//
//   node poller/poller.mjs                 # run the loop (normally via poller/start.sh)
//   node poller/poller.mjs --once          # one poll cycle, then exit (add --wait to wait for results)
//   node poller/poller.mjs --dry-run       # write command files locally instead of pushing
//   node poller/poller.mjs --since 2026-10-11T20:00:00Z   # override the first-run start time
//   node poller/poller.mjs --health        # print health.json; exit 1 if unhealthy or stale
//   node poller/poller.mjs --summarize-file transcript.txt  # run the summarizer on a text file
//   node poller/poller.mjs --send-command cmd.json [--name file.json]   # push one command, wait for result
//   node poller/poller.mjs --reset <convKey>  # retry a needs_attention conversation (new file name)
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
    pageSize: num(env.GROK_PAGE_SIZE, 60),
    repo: env.INBOX_REPO || "mogesjohnson/post-it-board",
    branch: env.INBOX_BRANCH || "inbox",
    githubApi: (env.GITHUB_API || "https://api.github.com").replace(/\/+$/, ""),
    llamaDir: env.LLAMA_DIR || "/workspace/llm/llama-b11559",
    llamaModel: env.LLAMA_MODEL || "/workspace/llm/qwen35-2b-q4km.gguf",
    llamaThreads: num(env.LLAMA_THREADS, 8),
    llamaPort: num(env.LLAMA_PORT, 0), // 0 = pick a free port
    minFreeMb: num(env.SUMMARIZER_MIN_FREE_MB, 1500),
    pinOverride: env.POLLER_PIN_OVERRIDE || "", // testing only: force the pin title
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
export const OVERHEAD_TOKENS = 700, MAX_OUT_TOKENS = 500, MAX_CTX = 16384, MIN_CTX = 4096;
export function fitTranscript(text, maxCtx = MAX_CTX) {
  const PREFIX = "[earlier part of the conversation omitted]\n";
  const budgetChars = Math.floor((maxCtx - OVERHEAD_TOKENS - MAX_OUT_TOKENS) * CHARS_PER_TOKEN) - PREFIX.length;
  let truncated = false;
  if (text.length > budgetChars) {
    // keep the END (the latest turns matter most), cut at a line boundary
    let cut = text.slice(text.length - budgetChars);
    const nl = cut.indexOf("\n");
    if (nl > 0 && nl < 2000) cut = cut.slice(nl + 1);
    text = PREFIX + cut;
    truncated = true;
  }
  const need = estTokens(text) + OVERHEAD_TOKENS + MAX_OUT_TOKENS;
  const ctx = Math.min(maxCtx, Math.max(MIN_CTX, Math.ceil(need / 1024) * 1024));
  return { text, ctx, truncated };
}

/* ------------------------------------------------------------------ */
/* summarizer: local llama.cpp, started on demand                      */
/* ------------------------------------------------------------------ */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    pin: { type: "string", minLength: 2, maxLength: 40 },
    title: { type: "string", minLength: 2, maxLength: 80 },
    body: { type: "string", minLength: 10, maxLength: 1200 },
  },
  required: ["pin", "title", "body"],
  additionalProperties: false,
};
export const SYSTEM_PROMPT = [
  "You turn a voice-chat transcript between a user and Grok into a short Post-it note.",
  "Use ONLY facts that are stated in the transcript. Do not invent names, numbers, dates or advice.",
  "The note is public: leave out phone numbers, addresses, health or money details and anything private.",
  "Cover every concrete decision, item, plan and time that was mentioned, most important first.",
  "Return JSON with: pin = short topic (1-4 words), title = short page title naming the subject (max 8 words; never \"Grok\" or \"conversation\"),",
  "body = either 2-4 plain sentences or 3-6 bullet lines that each start with \"- \", separated by \\n.",
].join(" ");

export function validateSummary(obj) {
  if (!obj || typeof obj !== "object") return "not an object";
  for (const k of ["pin", "title", "body"]) if (typeof obj[k] !== "string" || !obj[k].trim()) return `missing ${k}`;
  const extra = Object.keys(obj).filter(k => !["pin", "title", "body"].includes(k));
  if (extra.length) return `extra keys ${extra.join(",")}`;
  return null;
}

export const MAX_BULLETS = 6;
export function cleanSummary(s) {
  let body = s.body.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const lines = body.split("\n").filter(l => l.trim());
  // the model sometimes writes more than 6 bullets; the prompt asks for the most important first, so keep those
  if (lines.length > MAX_BULLETS && lines.every(l => /^\s*[-*•]\s/.test(l))) body = lines.slice(0, MAX_BULLETS).join("\n");
  return {
    pin: clip(s.pin.replace(/\s+/g, " ").trim(), 60),
    title: clip(s.title.replace(/\s+/g, " ").trim(), 120),
    body: clip(body, 4000),
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

export function createLlamaSummarizer(cfg, log = () => {}) {
  return {
    async summarize(transcript) {
      if (memAvailableMb() < cfg.minFreeMb) throw new PollerError("summarizer", `only ${Math.round(memAvailableMb())} MB RAM free (< ${cfg.minFreeMb}); will retry`);
      const fit = fitTranscript(transcript);
      const port = cfg.llamaPort || await freePort();
      const t0 = Date.now();
      const srv = spawn(path.join(cfg.llamaDir, "llama-server"), [
        "-m", cfg.llamaModel, "--host", "127.0.0.1", "--port", String(port), "-t", String(cfg.llamaThreads),
        "-c", String(fit.ctx), "--no-repack", "--no-mmproj", "-np", "1",
      ], { env: childEnv(cfg.llamaDir), stdio: "ignore" }); // server output can echo prompts: discard
      let exited = false; srv.on("exit", () => { exited = true; });
      const stop = async () => {
        if (exited) return;
        srv.kill("SIGTERM");
        for (let i = 0; i < 100 && !exited; i++) await sleep(100);
        if (!exited) srv.kill("SIGKILL");
      };
      try {
        const base = `http://127.0.0.1:${port}`;
        let up = false;
        for (let i = 0; i < 240 && !exited; i++) {
          try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break; } } catch {}
          await sleep(500);
        }
        if (!up) throw new PollerError("summarizer", exited ? "llama-server exited during startup" : "llama-server did not become healthy in 120 s");
        const loadMs = Date.now() - t0;
        const body = {
          messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `Transcript:\n${fit.text}` }],
          temperature: 0.2, max_tokens: MAX_OUT_TOKENS,
          response_format: { type: "json_schema", json_schema: { name: "note", schema: SUMMARY_SCHEMA } },
          chat_template_kwargs: { enable_thinking: false },
        };
        const t1 = Date.now();
        const r = await fetch(`${base}/v1/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000),
        });
        if (!r.ok) throw new PollerError("summarizer", `llama-server HTTP ${r.status}`);
        const data = await r.json();
        const mem = procMem(srv.pid);
        let parsed;
        try { parsed = JSON.parse(data.choices[0].message.content); } catch { throw new PollerError("summarizer", "model output is not valid JSON"); }
        const bad = validateSummary(parsed);
        if (bad) throw new PollerError("summarizer", `model output fails schema: ${bad}`);
        const stats = {
          ctx: fit.ctx, truncated: fit.truncated, loadMs, genMs: Date.now() - t1, totalMs: Date.now() - t0,
          promptTokens: data.timings?.prompt_n ?? data.usage?.prompt_tokens, outTokens: data.timings?.predicted_n ?? data.usage?.completion_tokens,
          ...(mem || {}),
        };
        log("info", "summarized", stats);
        return { summary: cleanSummary(parsed), stats };
      } finally { await stop(); }
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
/* commands                                                            */
/* ------------------------------------------------------------------ */
export function buildCommand(st, summary, { firstMsgTime, knownPins = [] }) {
  if (st.board) {
    const cmd = { op: "edit", target: "page", date: st.board.date, pin: st.board.pinTitle };
    if (st.board.pageTitle) cmd.page = st.board.pageTitle; else cmd.pageNumber = st.board.pageNumber;
    cmd.body = clip(summary.body, LIMITS.body);
    return cmd;
  }
  const date = nyDate(firstMsgTime);
  // reuse the exact title of a pin this poller already used that day (post.mjs: reuse exact titles)
  const same = knownPins.find(p => p.date === date && norm(p.pinTitle) === norm(summary.pin));
  const pin = clip(same ? same.pinTitle : summary.pin, LIMITS.pin);
  // stable, unique page title: model title + conversation start time (NY); edits find the page by it
  const title = clip(`${clip(summary.title, 120)} (${nyTime(firstMsgTime)})`, LIMITS.title);
  return { op: "add", date, pin, title, body: clip(summary.body, LIMITS.body) };
}

/* ------------------------------------------------------------------ */
/* the poller                                                          */
/* ------------------------------------------------------------------ */
export function createPoller({ cfg, reader, summarizer, inbox, log = () => {}, now = Date.now, statePath, healthPath }) {
  statePath ??= path.join(cfg.stateDir, "state.json");
  healthPath ??= path.join(cfg.stateDir, "health.json");
  const health = makeHealth(healthPath, now);
  let state = loadState(statePath);
  if (!state) {
    const since = cfg.since ? new Date(cfg.since).toISOString() : new Date(now()).toISOString();
    state = { version: 1, firstRunAt: new Date(now()).toISOString(), since, conversations: {}, pins: [] };
    log("info", "first run: no backfill", { since });
  } else if (cfg.since) {
    state.since = new Date(cfg.since).toISOString();
    log("info", "since overridden", { since: state.since });
  }
  const cache = new Map(); // conversationId -> messages (memory only, never persisted)
  const save = () => saveState(statePath, state);
  save();

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
      const prev = st.board;
      st.board = {
        date: r.date || p.cmd.date, pinTitle: r.matched?.pinTitle || p.cmd.pin,
        pageTitle: prev ? prev.pageTitle : (p.cmd.title?.trim() || null),
        pageNumber: r.pageNumber || prev?.pageNumber || null,
      };
      st.lastPostedMsgTime = p.lastTs; st.status = "posted";
      if (!state.pins.some(x => x.date === st.board.date && x.pinTitle === st.board.pinTitle)) state.pins.push({ date: st.board.date, pinTitle: st.board.pinTitle });
      state.pins = state.pins.slice(-50);
    } else if (r.status === "skipped_not_found" && p.op === "edit") {
      st.board = null; st.status = "quiet"; // next poll sends a fresh add (-add name)
    } else if (r.status === "error") {
      if (!p.alertedError) { p.alertedError = true; log("warn", "inbox Action error; waiting for a re-run", { conv: st.convKey, file: p.file }); }
      return; // keep pending
    } else {
      st.status = "needs_attention";
      log("warn", "needs attention", { conv: st.convKey, file: p.file, status: r.status });
    }
    st.pending = null;
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
    if (todo.filter(m => m.sender === "human").length === 0 || formatTranscript(todo).length < 40) {
      st.lastPostedMsgTime = last.createTime; st.status = st.board ? "posted" : "skipped_trivial";
      log("info", "nothing substantial to post", { conv: st.convKey, messages: todo.length }); return "trivial";
    }

    st.status = "quiet";
    log("info", "quiet; summarizing", { conv: st.convKey, messages: todo.length, quietMin: +(q.quietMs / 60000).toFixed(1), method: q.method, op: st.board ? "edit" : "add" });
    let summary;
    try { ({ summary } = await summarizer.summarize(formatTranscript(todo))); }
    catch (e) { throw e instanceof PollerError ? e : new PollerError("summarizer", e.message); }
    if (cfg.pinOverride) summary = { ...summary, pin: cfg.pinOverride };
    const cmd = buildCommand(st, summary, { firstMsgTime: msgs[0].createTime, knownPins: state.pins });
    const name = commandFileName(st.convKey, last.createTime, cmd.op, st.retry);
    const pushed = await inbox.pushIfAbsent(name, cmd);
    st.pending = { file: name, lastTs: last.createTime, op: cmd.op, pushedAt: new Date(nowMs).toISOString(), cmd };
    st.status = "posting";
    log("info", "pushed", { conv: st.convKey, file: name, op: cmd.op, state: pushed.state, commit: pushed.commit?.slice(0, 7) });
    save();
    if (pushed.state === "processed") await checkPending(conv.id, st);
    return "pushed";
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
          partError = e; // summarizer/push problem for one conversation: keep going, report it
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

export function backoffSeconds(failures, pollSeconds, maxSeconds = 600, retryAfterSec) {
  const b = Math.min(maxSeconds, pollSeconds * 2 ** Math.max(0, failures - 1));
  return Math.max(b, Math.min(retryAfterSec || 0, 3600));
}

// one loop iteration with health bookkeeping; returns how long to sleep (backoff on failures)
export async function pollOnce(poller, cfg, log = () => {}) {
  try {
    const r = await poller.cycle();
    if (r.ok) return { ok: true, wait: cfg.pollSeconds };
    return { ok: false, kind: r.error.kind, wait: backoffSeconds(poller.health.get().consecutiveFailures, cfg.pollSeconds, cfg.maxBackoffSeconds) };
  } catch (e) {
    const kind = e instanceof PollerError ? e.kind : "network";
    poller.health.fail(kind, e.message);
    const wait = backoffSeconds(poller.health.get().consecutiveFailures, cfg.pollSeconds, cfg.maxBackoffSeconds, e.retryAfterSec);
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

  if (!acquireLock(path.join(cfg.home, "poller.lock"))) { console.error("another poller is running (lock held)"); process.exit(3); }
  if (a.reset) {
    const p = createPoller({ cfg, reader: null, summarizer: null, inbox: null, log });
    const ok = p.reset(String(a.reset));
    console.log(ok ? `reset ${a.reset}: status quiet, retry bumped` : `no conversation with convKey ${a.reset}`);
    process.exit(ok ? 0 : 1);
  }
  const reader = cfg.reader === "browser" ? createBrowserReader()
    : createRestReader({ baseUrl: cfg.grokBase, cookie: process.env.GROK_COOKIE, pageSize: cfg.pageSize });
  const poller = createPoller({ cfg, reader, summarizer: createLlamaSummarizer(cfg, log), inbox: makeInbox(), log });
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
