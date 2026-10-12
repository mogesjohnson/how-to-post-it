// Unit tests (SYNTHETIC fixtures only). Run: node poller/test/run.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as P from "../poller.mjs";
import { startFakeGrok } from "./fake-grok.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "poller-test-"));
const QUIET = "synthetic-voice-quiet-0001", OLD = "synthetic-voice-old-0004", ACTIVE = "synthetic-voice-active-0002", OPTOUT = "synthetic-voice-optout-0005";

function cfgFor(dir, extra = {}) {
  return { ...P.loadConfig({ POLLER_HOME: dir }, []), stateDir: dir, ...extra };
}
function fakeSummarizer(over = {}) {
  const calls = [];
  return { calls, async summarize(text) { calls.push(text.length); if (over.fail) throw new P.PollerError("summarizer", "boom"); return { summary: { pin: over.pin || "Garden bed", title: "Raised bed plan", body: "- 4 x 8 ft cedar bed\n- Tomatoes and basil\n- Buy boards and soil Saturday" }, stats: {} }; } };
}
function memInbox() {
  const files = new Map(), results = new Map(), puts = [];
  return {
    files, results, puts, kind: "mem",
    async getResult(n) { return results.get(n) || null; },
    async commandExists(n) { return files.has(n); },
    async pushIfAbsent(n, cmd) {
      if (results.has(n)) return { state: "processed", result: results.get(n) };
      if (files.has(n)) return { state: "waiting" };
      files.set(n, cmd); puts.push({ name: n, cmd }); return { state: "pushed", commit: "abc1234" };
    },
    // simulate the GitHub Action processing one file
    process(n, over = {}) {
      const cmd = files.get(n); files.delete(n);
      results.set(n, { status: "ok", op: cmd.op, input: cmd, matched: { pinTitle: cmd.pin }, message: "", processedAt: new Date().toISOString(), date: cmd.date, pageNumber: 2, ...over });
    },
  };
}
async function setup({ since, summarizer = fakeSummarizer(), mode = "ok" } = {}) {
  const fake = await startFakeGrok({ mode });
  const dir = tmp();
  const cfg = cfgFor(dir, since ? { since } : {});
  const reader = P.createRestReader({ baseUrl: fake.url, cookie: "sso=synthetic; sso-rw=synthetic" });
  const inbox = memInbox();
  const poller = P.createPoller({ cfg, reader, summarizer, inbox });
  return { fake, dir, cfg, reader, inbox, poller, summarizer };
}

/* ---------- quiet detection ---------- */
test("quiet: both newest createTime and modifyTime must be >= QUIET_MINUTES old", () => {
  const now = Date.parse("2026-10-11T22:00:00Z"), min = 60_000;
  assert.equal(P.quietInfo({ nowMs: now, newestMs: now - 11 * min, modifyMs: now - 11 * min, quietMinutes: 10 }).quiet, true);
  assert.equal(P.quietInfo({ nowMs: now, newestMs: now - 10 * min, modifyMs: now - 10 * min, quietMinutes: 10 }).quiet, true, "exactly 10 min counts");
  assert.equal(P.quietInfo({ nowMs: now, newestMs: now - 11 * min, modifyMs: now - 5 * min, quietMinutes: 10 }).quiet, false, "recent modifyTime keeps it active");
  assert.equal(P.quietInfo({ nowMs: now, newestMs: now - 3 * min, modifyMs: now - 20 * min, quietMinutes: 10 }).quiet, false, "recent message keeps it active");
  assert.equal(P.quietInfo({ nowMs: now, newestMs: now - 6 * min, modifyMs: now - 6 * min, quietMinutes: 5 }).quiet, true, "QUIET_MINUTES configurable");
  const skew = P.quietInfo({ nowMs: now, newestMs: now + 5 * min, modifyMs: now, firstSeenAtMs: now - 12 * min, quietMinutes: 10 });
  assert.equal(skew.method, "observed"); assert.equal(skew.quiet, true, "future timestamps fall back to our own clock");
});

test("config: QUIET_MINUTES default 10, poll clamped to 60-120 s", () => {
  assert.equal(P.loadConfig({}, []).quietMinutes, 10);
  assert.equal(P.loadConfig({ QUIET_MINUTES: "15" }, []).quietMinutes, 15);
  assert.equal(P.loadConfig({ POLL_SECONDS: "5" }, []).pollSeconds, 60);
  assert.equal(P.loadConfig({ POLL_SECONDS: "600" }, []).pollSeconds, 120);
  assert.equal(P.loadConfig({}, []).pollSeconds, 90);
});

/* ---------- first run, no backfill ---------- */
test("first run: only voice conversations modified after start; quiet one -> one add; active/typed/old ignored", async () => {
  const since = new Date(Date.now() - 60 * 60_000).toISOString(); // stands in for "poller started an hour ago"
  const t = await setup({ since });
  try {
    const r = await t.poller.cycle();
    assert.equal(r.ok, true);
    assert.equal(t.inbox.puts.length, 1);
    const { name, cmd } = t.inbox.puts[0];
    assert.match(name, new RegExp(`^auto-${P.convKey(QUIET)}-\\d{8}T\\d{6}Z-add\\.json$`));
    assert.equal(cmd.op, "add"); assert.equal(cmd.pin, "Garden bed"); assert.match(cmd.title, /^Raised bed plan \(\d{1,2}:\d{2} [AP]M\)$/);
    assert.deepEqual(Object.keys(cmd).sort(), ["body", "date", "op", "pin", "title"]);
    assert.ok(!(OLD in t.poller.state.conversations), "old conversation (before start) is not touched");
    assert.ok(!("synthetic-text-quiet-0003" in t.poller.state.conversations), "typed chat ignored");
    assert.equal(t.poller.state.conversations[ACTIVE].status, "active");
    assert.equal(t.poller.state.conversations[OPTOUT].status, "opted_out");
    assert.equal(t.fake.stats.loadResponses, 2, "bodies loaded only for the quiet + opt-out conversations, not the active one");
    assert.equal(t.summarizer.calls.length, 1);
  } finally { await t.fake.close(); }
});

test("first run with no --since uses the start time: nothing older is posted", async () => {
  const t = await setup();
  try {
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 0);
    assert.ok(Date.now() - Date.parse(t.poller.state.since) < 5000);
    // restart with the same state file keeps the original since
    const p2 = P.createPoller({ cfg: t.cfg, reader: t.reader, summarizer: t.summarizer, inbox: t.inbox });
    assert.equal(p2.state.since, t.poller.state.since);
  } finally { await t.fake.close(); }
});

test("--since override reaches older conversations", async () => {
  const t = await setup({ since: new Date(Date.now() - 4 * 86400_000).toISOString() });
  try {
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 2);
    assert.ok(t.inbox.puts.some(p => p.name.includes(P.convKey(OLD))));
  } finally { await t.fake.close(); }
});

/* ---------- add vs edit on resume ---------- */
test("resume: add -> ok -> new messages -> quiet -> edit with exact pin/page from the result", async () => {
  const t = await setup({ since: new Date(Date.now() - 3600_000).toISOString() });
  try {
    await t.poller.cycle();
    const add = t.inbox.puts[0];
    // the Action fuzzy-matched an existing pin with different wording
    t.inbox.process(add.name, { matched: { pinTitle: "Garden Beds" }, pageNumber: 3 });
    await t.poller.cycle();
    const st = t.poller.state.conversations[QUIET];
    assert.equal(st.status, "posted");
    assert.deepEqual(st.board, { date: add.cmd.date, pinTitle: "Garden Beds", pageTitle: add.cmd.title, pageNumber: 3 });
    assert.equal(st.lastResult.status, "ok");
    // unchanged: no new push, no reload
    const loads = t.fake.stats.loadResponses;
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 1); assert.equal(t.fake.stats.loadResponses, loads);
    // conversation resumes and goes quiet again
    await fetch(`${t.fake.url}/__admin/append`, { method: "POST", body: JSON.stringify({ conversationId: QUIET, messages: [
      { sender: "human", minAgo: 12, message: "Add marigolds along the edge of the bed." },
      { sender: "assistant", minAgo: 11.9, message: "Marigolds along the edge, noted." }] }) });
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 2);
    const edit = t.inbox.puts[1];
    assert.deepEqual(edit.cmd, { op: "edit", target: "page", date: add.cmd.date, pin: "Garden Beds", page: add.cmd.title, body: edit.cmd.body });
    assert.match(edit.name, /-edit\.json$/); assert.notEqual(edit.name, add.name);
    t.inbox.process(edit.name);
    await t.poller.cycle();
    assert.equal(t.poller.state.conversations[QUIET].board.pageTitle, add.cmd.title, "page title is kept across edits");
    assert.equal(t.poller.state.conversations[QUIET].status, "posted");
  } finally { await t.fake.close(); }
});

test("edit -> skipped_not_found -> fresh add with an -add name", async () => {
  const t = await setup({ since: new Date(Date.now() - 3600_000).toISOString() });
  try {
    await t.poller.cycle();
    t.inbox.process(t.inbox.puts[0].name);
    await t.poller.cycle();
    await fetch(`${t.fake.url}/__admin/append`, { method: "POST", body: JSON.stringify({ conversationId: QUIET, messages: [{ sender: "human", minAgo: 11, message: "One more thing: mulch on top." }] }) });
    await t.poller.cycle();
    const edit = t.inbox.puts[1];
    t.inbox.process(edit.name, { status: "skipped_not_found", pageNumber: undefined });
    await t.poller.cycle(); // reads the result -> board cleared -> new add in the same cycle
    const last = t.inbox.puts.at(-1);
    assert.equal(last.cmd.op, "add"); assert.match(last.name, /-add\.json$/);
    assert.equal(last.name.replace(/-add\.json$/, ""), edit.name.replace(/-edit\.json$/, ""), "same conv+timestamp, different op suffix");
  } finally { await t.fake.close(); }
});

test("needs_attention on skipped_ambiguous; reset bumps retry -> -r1 file name", async () => {
  const t = await setup({ since: new Date(Date.now() - 3600_000).toISOString() });
  try {
    await t.poller.cycle();
    t.inbox.process(t.inbox.puts[0].name, { status: "skipped_ambiguous", pageNumber: undefined });
    await t.poller.cycle();
    assert.equal(t.poller.state.conversations[QUIET].status, "needs_attention");
    assert.equal(t.inbox.puts.length, 1, "no retry on its own");
    assert.ok(t.poller.reset(P.convKey(QUIET)));
    await t.poller.cycle();
    assert.match(t.inbox.puts.at(-1).name, /-add-r1\.json$/);
  } finally { await t.fake.close(); }
});

/* ---------- naming / dedup ---------- */
test("file names are deterministic and dedup-safe", () => {
  const k = P.convKey("synthetic-id");
  assert.match(k, /^[0-9a-f]{10}$/);
  const n1 = P.commandFileName(k, "2026-10-06T01:15:12.345Z", "add");
  assert.equal(n1, `auto-${k}-20261006T011512Z-add.json`);
  assert.equal(P.commandFileName(k, "2026-10-06T01:15:12.345Z", "add"), n1);
  assert.notEqual(P.commandFileName(k, "2026-10-06T01:38:40.000Z", "add"), n1);
  assert.equal(P.commandFileName(k, "2026-10-06T01:15:12.345Z", "add", 2), `auto-${k}-20261006T011512Z-add-r2.json`);
  assert.ok(!n1.includes("synthetic-id"), "raw conversation id never in the public file name");
});

test("same state twice (crash/restart before result) does not push a second file", async () => {
  const t = await setup({ since: new Date(Date.now() - 3600_000).toISOString() });
  try {
    await t.poller.cycle();
    const p2 = P.createPoller({ cfg: t.cfg, reader: t.reader, summarizer: t.summarizer, inbox: t.inbox }); // restart, new memory
    await p2.cycle();
    assert.equal(t.inbox.puts.length, 1);
    // lost state entirely: the deterministic name + push-if-absent still refuses a duplicate
    fs.rmSync(path.join(t.dir, "state.json"));
    const p3 = P.createPoller({ cfg: { ...t.cfg, since: t.cfg.since }, reader: t.reader, summarizer: t.summarizer, inbox: t.inbox });
    p3.state.since = new Date(Date.now() - 3600_000).toISOString();
    await p3.cycle();
    assert.equal(t.inbox.puts.length, 1);
  } finally { await t.fake.close(); }
});

test("GitHub push-if-absent: existing result / existing command / 409 retry / PUT body", async () => {
  const calls = [];
  const mk = routes => async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    for (const [re, fn] of routes) if (re.test(`${init.method} ${url}`)) return fn(url, init);
    return new Response("{}", { status: 404 });
  };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64");
  // 1) result exists
  let gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", fetchFn: mk([[/GET .*inbox\/results\/a\.json\?ref=inbox$/, () => Response.json({ content: b64({ status: "ok" }) })]]) });
  assert.deepEqual(await gh.pushIfAbsent("a.json", { op: "add" }), { state: "processed", result: { status: "ok" } });
  assert.ok(!calls.some(c => c.method === "PUT"));
  // 2) command waiting
  calls.length = 0;
  gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", fetchFn: mk([[/GET .*contents\/inbox\/a\.json\?ref=inbox$/, () => Response.json({ content: b64({ op: "add" }) })]]) });
  assert.deepEqual(await gh.pushIfAbsent("a.json", { op: "add" }), { state: "waiting" });
  // 3) 409 once, then created
  calls.length = 0; let n = 0;
  gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", backoffMs: 1, fetchFn: mk([[/PUT /, () => (n++ ? Response.json({ commit: { sha: "deadbeef" } }, { status: 201 }) : new Response("{}", { status: 409 }))]]) });
  const cmd = { op: "add", pin: "Poller test", title: "x", body: "y" };
  assert.deepEqual(await gh.pushIfAbsent("b.json", cmd), { state: "pushed", commit: "deadbeef" });
  const put = calls.filter(c => c.method === "PUT").at(-1);
  assert.equal(calls.filter(c => c.method === "PUT").length, 2);
  assert.match(put.url, /\/repos\/o\/r\/contents\/inbox\/b\.json$/);
  const pb = JSON.parse(put.body);
  assert.equal(pb.branch, "inbox"); assert.deepEqual(JSON.parse(Buffer.from(pb.content, "base64").toString()), cmd);
  // 4) bad token -> push error
  gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", fetchFn: mk([[/PUT /, () => new Response("{}", { status: 401 })]]) });
  await assert.rejects(gh.pushIfAbsent("c.json", cmd), e => e.kind === "push");
});

test("commands match post.mjs: limits, allowed fields, exact pin reuse", () => {
  const long = "x".repeat(6000);
  const add = P.buildCommand({ board: null }, { pin: "garden bed!", title: "T", body: long }, { firstMsgTime: "2026-10-12T01:30:00Z", knownPins: [{ date: "2026-10-11", pinTitle: "Garden Bed" }] });
  assert.equal(add.date, "2026-10-11", "NY date of the conversation start (01:30Z = 9:30 PM EDT)");
  assert.equal(add.pin, "Garden Bed"); assert.equal(add.title, "T (9:30 PM)");
  assert.ok(add.body.length <= 5000);
  const ed = P.buildCommand({ board: { date: "2026-10-11", pinTitle: "Garden Bed", pageTitle: null, pageNumber: 4 } }, { pin: "p", title: "t", body: "b" }, { firstMsgTime: "2026-10-12T01:30:00Z" });
  assert.deepEqual(ed, { op: "edit", target: "page", date: "2026-10-11", pin: "Garden Bed", pageNumber: 4, body: "b" });
  const allowed = ["op", "date", "pin", "title", "body", "color", "target", "page", "pageNumber", "newPin"];
  for (const c of [add, ed]) assert.ok(Object.keys(c).every(k => allowed.includes(k)));
});

/* ---------- health classification ---------- */
async function healthAfter(mode, readerOpts = {}) {
  const t = await setup({ mode, since: new Date(Date.now() - 3600_000).toISOString() });
  try {
    const reader = readerOpts.reader || t.reader;
    const poller = P.createPoller({ cfg: t.cfg, reader, summarizer: t.summarizer, inbox: t.inbox });
    const r1 = await P.pollOnce(poller, t.cfg);
    const r2 = await P.pollOnce(poller, t.cfg);
    const h = JSON.parse(fs.readFileSync(path.join(t.dir, "health.json"), "utf8"));
    return { r1, r2, h, t };
  } finally { await t.fake.close(); }
}
test("health: 401 -> auth, backoff grows", async () => {
  const { r1, r2, h } = await healthAfter("401");
  assert.equal(h.ok, false); assert.equal(h.kind, "auth"); assert.equal(h.consecutiveFailures, 2);
  assert.ok(r2.wait > r1.wait);
  assert.equal(P.healthVerdict(h).healthy, false);
});
test("health: HTML challenge page -> auth", async () => {
  const { h } = await healthAfter("challenge");
  assert.equal(h.kind, "auth"); assert.match(h.lastError.message, /challenge/);
});
test("health: missing expected fields -> schema", async () => {
  const { h } = await healthAfter("schema");
  assert.equal(h.kind, "schema");
  assert.equal(P.validateResponses.length, 1);
  assert.throws(() => P.validateResponses({ responses: [{ sender: "human", createTime: "2026-10-11T00:00:00Z" }] }), e => e.kind === "schema");
  assert.throws(() => P.validateList({ items: [] }), e => e.kind === "schema");
});
test("health: missing cookie -> auth; unreachable host -> network; 200 HTML login page -> auth", async () => {
  assert.throws(() => P.createRestReader({ cookie: "" }), e => e.kind === "auth");
  const r = P.createRestReader({ baseUrl: "http://127.0.0.1:9", cookie: "sso=x" });
  await assert.rejects(r.listRecentConversations(), e => e.kind === "network");
  const html = P.createRestReader({ cookie: "sso=x", fetchFn: async () => new Response("<html><body>Sign in</body></html>", { status: 200, headers: { "content-type": "text/html" } }) });
  await assert.rejects(html.listRecentConversations(), e => e.kind === "auth");
  const r429 = P.createRestReader({ cookie: "sso=x", fetchFn: async () => new Response("", { status: 429, headers: { "retry-after": "120" } }) });
  await assert.rejects(r429.listRecentConversations(), e => e.kind === "network" && e.retryAfterSec === 120);
  assert.equal(P.backoffSeconds(1, 90, 600, 120), 120);
  assert.equal(P.backoffSeconds(10, 90, 600), 600, "max ~10 min");
});
test("health: summarizer failure is reported but nothing is pushed; recovery resets the counter", async () => {
  const t = await setup({ summarizer: fakeSummarizer({ fail: true }), since: new Date(Date.now() - 3600_000).toISOString() });
  try {
    const r = await P.pollOnce(t.poller, t.cfg);
    assert.equal(r.ok, false); assert.equal(r.kind, "summarizer");
    assert.equal(t.inbox.puts.length, 0);
    const p2 = P.createPoller({ cfg: t.cfg, reader: t.reader, summarizer: fakeSummarizer(), inbox: t.inbox });
    assert.equal((await P.pollOnce(p2, t.cfg)).ok, true);
    const h = JSON.parse(fs.readFileSync(path.join(t.dir, "health.json"), "utf8"));
    assert.equal(h.ok, true); assert.equal(h.consecutiveFailures, 0); assert.equal(t.inbox.puts.length, 1);
  } finally { await t.fake.close(); }
});
test("--health CLI exits non-zero when unhealthy or stale, zero when ok", async () => {
  const dir = tmp();
  const run = () => spawnSync(process.execPath, [path.join(here, "../poller.mjs"), "--health"], { env: { ...process.env, POLLER_HOME: dir }, encoding: "utf8" });
  assert.equal(run().status, 1, "no health file");
  const h = P.makeHealth(path.join(dir, "health.json"));
  h.fail("auth", "HTTP 401");
  let r = run(); assert.equal(r.status, 1); assert.match(r.stdout, /"kind": "auth"/);
  h.ok(); assert.equal(run().status, 0);
  const stale = JSON.parse(fs.readFileSync(path.join(dir, "health.json"))); stale.updatedAt = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(stale));
  r = run(); assert.equal(r.status, 1); assert.match(r.stdout, /stale/);
});

/* ---------- transcript prep / privacy ---------- */
test("transcript fit: 4096 min ctx, 16384 max, long input keeps the END", () => {
  assert.equal(P.fitTranscript("User: hi").ctx, 4096);
  const mid = "User: " + "a".repeat(30000);
  assert.ok(P.fitTranscript(mid).ctx > 4096 && P.fitTranscript(mid).ctx <= 16384);
  const lines = Array.from({ length: 4000 }, (_, i) => `User: line ${i} ${"z".repeat(20)}`).join("\n");
  const f = P.fitTranscript(lines);
  assert.equal(f.truncated, true); assert.equal(f.ctx, 16384);
  assert.ok(f.text.endsWith("line 3999 " + "z".repeat(20))); assert.ok(!f.text.includes("line 0 "));
  assert.ok(P.estTokens(f.text) + P.OVERHEAD_TOKENS + P.MAX_OUT_TOKENS <= 16384);
});
test("opt-out phrases and Ara's post-it point", () => {
  assert.equal(P.hasOptOut([{ sender: "human", text: "Don’t post this please" }]), true);
  assert.equal(P.hasOptOut([{ sender: "assistant", text: "don't post this" }]), false);
  const msgs = [{ sender: "human", text: "a" }, { sender: "human", text: "ok post it" }, { sender: "assistant", text: "Posted." }, { sender: "human", text: "more" }];
  assert.equal(P.araPostPoint(msgs), 3);
});
test("privacy: the log never contains message text or the cookie", async () => {
  const dir = tmp(); const logFile = path.join(dir, "poller.log");
  const fake = await startFakeGrok();
  try {
    const cfg = cfgFor(dir, { since: new Date(Date.now() - 3600_000).toISOString() });
    const poller = P.createPoller({ cfg, reader: P.createRestReader({ baseUrl: fake.url, cookie: "sso=SECRETCOOKIE123" }), summarizer: fakeSummarizer(), inbox: memInbox(), log: P.makeLogger(logFile, { echo: false }) });
    await P.pollOnce(poller, cfg, P.makeLogger(logFile, { echo: false }));
    const log = fs.readFileSync(logFile, "utf8");
    for (const bad of ["SECRETCOOKIE123", "garden bed", "tomatoes", "cedar", "off the record", QUIET, OPTOUT]) assert.ok(!log.toLowerCase().includes(bad.toLowerCase()), `leaked: ${bad}`);
    assert.ok(log.includes(P.convKey(QUIET)), "hashed key is logged instead");
    assert.ok(log.includes("summarizing"));
  } finally { await fake.close(); }
});

test("secrets file: literal values, refuses group/other-readable files, env wins", () => {
  const dir = tmp(), f = path.join(dir, "env");
  fs.writeFileSync(f, "# comment\nGROK_COOKIE=sso=abc; sso-rw=def; x-userid=1\nexport INBOX_GITHUB_TOKEN='tok'\nQUIET_MINUTES=12\n", { mode: 0o644 });
  assert.throws(() => P.loadEnvFile(f, {}), /chmod 600/);
  fs.chmodSync(f, 0o600);
  const env = { QUIET_MINUTES: "7" };
  assert.equal(P.loadEnvFile(f, env), true);
  assert.equal(env.GROK_COOKIE, "sso=abc; sso-rw=def; x-userid=1");
  assert.equal(env.INBOX_GITHUB_TOKEN, "tok");
  assert.equal(env.QUIET_MINUTES, "7");
  assert.equal(P.loadEnvFile(path.join(dir, "missing"), {}), false);
});

test("summary cleanup: at most 6 bullets, schema check", () => {
  const body = Array.from({ length: 9 }, (_, i) => `- item ${i}`).join("\n");
  assert.equal(P.cleanSummary({ pin: " Camping ", title: "Trip", body }).body.split("\n").length, 6);
  assert.equal(P.cleanSummary({ pin: "a", title: "b", body: "One. Two. Three." }).body, "One. Two. Three.");
  assert.equal(P.validateSummary({ pin: "a", title: "b", body: "c" }), null);
  assert.match(P.validateSummary({ pin: "a", title: "b" }), /missing body/);
  assert.match(P.validateSummary({ pin: "a", title: "b", body: "c", x: 1 }), /extra/);
});

/* ---------- runner ---------- */
let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`ok   ${t.name}`); }
  catch (e) { fail++; console.log(`FAIL ${t.name}\n     ${e.stack.split("\n").slice(0, 4).join("\n     ")}`); }
}
console.log(`\n${pass} passed, ${fail} failed (${tests.length} tests)`);
process.exit(fail ? 1 : 0);
