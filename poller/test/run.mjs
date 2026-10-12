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
// Fake model: the poller only sees withModel(ctx, fn) -> fn(ops). Each op is scripted and recorded.
function fakeSummarizer(over = {}) {
  const calls = [];
  const ops = {
    async match(topics, transcript) { calls.push({ op: "match", names: topics.map(t => t.pinTitle), transcript }); return { topic: typeof over.match === "function" ? over.match(topics, transcript) : (over.match || "NEW") }; },
    async summarizeNew(transcript) { calls.push({ op: "new", transcript }); return { pin: over.pin || "Garden bed", title: "Raised bed plan", body: "- 4 x 8 ft cedar bed\n- Tomatoes and basil\n- Buy boards and soil Saturday", reasked: false, truncated: false }; },
    async merge(name, current, transcript) { calls.push({ op: "merge", name, current, transcript }); return { body: `${current}\n- merged update`, reasked: false, truncated: false }; },
    async compact(name, current, target) { calls.push({ op: "compact", name, before: current.length, target }); return { body: over.compactBody ?? current.slice(0, target), reasked: false, truncated: false }; },
  };
  return {
    calls,
    async withModel(ctx, fn) { calls.push({ op: "session", ctx }); if (over.fail) throw new P.PollerError("summarizer", "boom"); return { result: await fn(ops), stats: { ctx } }; },
  };
}
// Fake board (what the public anon read returns) + fake inbox whose process() applies commands like post.mjs
function fakeBoard(seed = []) {
  let n = 0;
  const pins = seed.map(t => ({ id: `pin-${++n}`, title: t.pinTitle, date: t.date, updatedAt: t.updatedAt || "2026-10-05T12:00:00.000Z", pages: (t.pages || []).map(b => ({ body: b, updatedAt: t.updatedAt || "2026-10-05T12:00:00.000Z" })) }));
  const stamp = () => new Date(Date.now() + n++).toISOString();
  return {
    pins, reads: 0,
    async listTopics() {
      this.reads++;
      return P.topicsFromRows(pins.map(p => ({ id: p.id, title: p.title, created_at: p.updatedAt, updated_at: p.updatedAt, day: { board_date: p.date },
        pages: p.pages.map((g, i) => ({ id: `${p.id}-g${i}`, title: "Summary", body: g.body, position: i, created_at: g.updatedAt, updated_at: g.updatedAt })) })));
    },
    apply(cmd) {
      const pin = pins.find(p => p.date === cmd.date && p.title.toLowerCase() === cmd.pin.toLowerCase());
      if (cmd.op === "add") {
        const p = pin || (pins.push({ id: `pin-${++n}`, title: cmd.pin, date: cmd.date, updatedAt: stamp(), pages: [] }), pins.at(-1));
        p.pages.push({ body: cmd.body, updatedAt: stamp() });
        return { status: "ok", matched: { pinTitle: p.title }, pageNumber: p.pages.length, date: cmd.date };
      }
      if (cmd.op === "edit") {
        const g = pin?.pages[(cmd.pageNumber || 1) - 1];
        if (!g) return { status: "skipped_not_found", matched: { pinTitle: null }, date: cmd.date };
        g.body = cmd.body; g.updatedAt = stamp();
        return { status: "ok", matched: { pinTitle: pin.title }, pageNumber: cmd.pageNumber, date: cmd.date };
      }
      if (cmd.op === "delete") { pins.splice(pins.indexOf(pin), 1); return { status: "ok", matched: { pinTitle: cmd.pin }, date: cmd.date }; }
    },
  };
}
function memInbox(board) {
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
    // simulate the GitHub Action processing one file (applied to the fake board unless the result is overridden)
    process(n, over = null) {
      const cmd = files.get(n); files.delete(n);
      const r = over ? { status: "ok", matched: { pinTitle: cmd.pin }, date: cmd.date, ...over } : (board ? board.apply(cmd) : { status: "ok", matched: { pinTitle: cmd.pin }, date: cmd.date, pageNumber: 1 });
      results.set(n, { op: cmd.op, input: cmd, message: "", processedAt: new Date().toISOString(), ...r });
    },
    processAll() { for (const n of [...files.keys()]) this.process(n); },
  };
}
async function setup({ since, summarizer = fakeSummarizer(), mode = "ok", topics = [], cfgExtra = {} } = {}) {
  const fake = await startFakeGrok({ mode });
  const dir = tmp();
  const cfg = cfgFor(dir, { ...(since ? { since } : {}), ...cfgExtra });
  const reader = P.createRestReader({ baseUrl: fake.url, cookie: "sso=synthetic; sso-rw=synthetic" });
  const board = fakeBoard(topics);
  const inbox = memInbox(board);
  const poller = P.createPoller({ cfg, reader, summarizer, inbox, board });
  return { fake, dir, cfg, reader, inbox, poller, summarizer, board };
}
const HOUR_AGO = () => new Date(Date.now() - 3600_000).toISOString();
const append = (t, conversationId, messages) => fetch(`${t.fake.url}/__admin/append`, { method: "POST", body: JSON.stringify({ conversationId, messages }) });

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
test("first run: only voice conversations modified after start; quiet one -> NEW topic add; active/typed/old ignored", async () => {
  const since = new Date(Date.now() - 60 * 60_000).toISOString(); // stands in for "poller started an hour ago"
  const t = await setup({ since });
  try {
    const r = await t.poller.cycle();
    assert.equal(r.ok, true);
    assert.equal(t.inbox.puts.length, 1);
    const { name, cmd } = t.inbox.puts[0];
    assert.match(name, new RegExp(`^auto-${P.convKey(QUIET)}-\\d{8}T\\d{6}Z-add\\.json$`));
    assert.deepEqual(Object.keys(cmd).sort(), ["body", "date", "op", "pin", "title"]);
    assert.equal(cmd.op, "add"); assert.equal(cmd.pin, "Garden bed"); assert.equal(cmd.title, "Summary");
    assert.ok(!(OLD in t.poller.state.conversations), "old conversation (before start) is not touched");
    assert.ok(!("synthetic-text-quiet-0003" in t.poller.state.conversations), "typed chat ignored");
    assert.equal(t.poller.state.conversations[ACTIVE].status, "active");
    assert.equal(t.poller.state.conversations[OPTOUT].status, "opted_out");
    assert.equal(t.fake.stats.loadResponses, 2, "bodies loaded only for the quiet + opt-out conversations, not the active one");
    assert.deepEqual(t.summarizer.calls.map(c => c.op), ["session", "new"], "empty board: no match call, one model session");
  } finally { await t.fake.close(); }
});

test("first run with no --since uses the start time: nothing older is posted", async () => {
  const t = await setup();
  try {
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 0);
    assert.ok(Date.now() - Date.parse(t.poller.state.since) < 5000);
    const p2 = P.createPoller({ cfg: t.cfg, reader: t.reader, summarizer: t.summarizer, inbox: t.inbox, board: t.board });
    assert.equal(p2.state.since, t.poller.state.since, "restart keeps the original since");
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

/* ---------- topic papers: match / NEW / merge ---------- */
const GARDEN = { pinTitle: "Garden Beds", date: "2026-10-05", pages: ["- Cedar beds on the south side\n- Soil delivery pending"] };
const WELCOME = { pinTitle: "Post-it Board", date: "2026-10-05", pages: ["This board was set up today."] };

test("topic match: the chat matches an existing topic -> edit page 1 of that pin on ITS day, merged body", async () => {
  const t = await setup({ since: HOUR_AGO(), topics: [GARDEN, WELCOME, { pinTitle: "Bike podcast", date: "2026-10-06", pages: ["- Episode ideas"] }], summarizer: fakeSummarizer({ match: "Garden Beds" }) });
  try {
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 1);
    const { name, cmd } = t.inbox.puts[0];
    assert.match(name, /-edit\.json$/);
    assert.deepEqual(cmd, { op: "edit", target: "page", date: "2026-10-05", pin: "Garden Beds", pageNumber: 1, body: `${GARDEN.pages[0]}\n- merged update` });
    const m = t.summarizer.calls.find(c => c.op === "match");
    assert.deepEqual(m.names.sort(), ["Bike podcast", "Garden Beds"], "the excluded welcome note is never offered");
    const mg = t.summarizer.calls.find(c => c.op === "merge");
    assert.equal(mg.current, GARDEN.pages[0]); assert.match(mg.transcript, /raised garden bed/);
    t.inbox.processAll(); await t.poller.cycle();
    const st = t.poller.state.conversations[QUIET];
    assert.equal(st.status, "posted"); assert.deepEqual(st.board, { date: "2026-10-05", pinTitle: "Garden Beds", pageNumber: 1 });
    assert.equal(t.board.pins.find(p => p.title === "Garden Beds").pages.length, 1, "still one page: the living summary");
  } finally { await t.fake.close(); }
});

test("topic match: NEW -> add a new pin (conversation's NY date, page title Summary)", async () => {
  const t = await setup({ since: HOUR_AGO(), topics: [GARDEN], summarizer: fakeSummarizer({ match: "NEW", pin: "Weekend errands" }) });
  try {
    await t.poller.cycle();
    const { cmd } = t.inbox.puts[0];
    assert.equal(cmd.op, "add"); assert.equal(cmd.pin, "Weekend errands"); assert.equal(cmd.title, "Summary");
    assert.equal(cmd.date, P.nyDate(Date.now() - 30 * 60_000));
    assert.deepEqual(t.summarizer.calls.map(c => c.op), ["session", "match", "new"]);
  } finally { await t.fake.close(); }
});

test("NEW summary whose pin name already exists -> merged into that topic instead of a second pin", async () => {
  const t = await setup({ since: HOUR_AGO(), topics: [GARDEN], summarizer: fakeSummarizer({ match: "NEW", pin: "garden beds!" }) });
  try {
    await t.poller.cycle();
    const { cmd } = t.inbox.puts[0];
    assert.equal(cmd.op, "edit"); assert.equal(cmd.pin, "Garden Beds"); assert.equal(cmd.pageNumber, 1);
  } finally { await t.fake.close(); }
});

test("resume: add -> ok -> new messages -> quiet -> merge ONLY the new messages into the same topic", async () => {
  const t = await setup({ since: HOUR_AGO() });
  try {
    await t.poller.cycle();
    const add = t.inbox.puts[0];
    t.inbox.processAll(); await t.poller.cycle();
    assert.deepEqual(t.poller.state.conversations[QUIET].board, { date: add.cmd.date, pinTitle: "Garden bed", pageNumber: 1 });
    const loads = t.fake.stats.loadResponses, sessions = t.summarizer.calls.filter(c => c.op === "session").length;
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 1); assert.equal(t.fake.stats.loadResponses, loads, "unchanged: no reload");
    await append(t, QUIET, [{ sender: "human", minAgo: 12, message: "Add marigolds along the edge of the bed." }, { sender: "assistant", minAgo: 11.9, message: "Marigolds along the edge, noted." }]);
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 2);
    const edit = t.inbox.puts[1];
    assert.deepEqual(edit.cmd, { op: "edit", target: "page", date: add.cmd.date, pin: "Garden bed", pageNumber: 1, body: edit.cmd.body });
    assert.match(edit.name, /-edit\.json$/);
    const mg = t.summarizer.calls.filter(c => c.op === "merge").at(-1);
    assert.match(mg.transcript, /marigolds/i); assert.doesNotMatch(mg.transcript, /four feet by eight/, "already-posted turns are not re-sent");
    assert.equal(t.summarizer.calls.filter(c => c.op === "match").length, 0, "resume needs no matching");
    assert.equal(t.summarizer.calls.filter(c => c.op === "session").length, sessions + 1);
    t.inbox.processAll(); await t.poller.cycle();
    assert.equal(t.poller.state.conversations[QUIET].status, "posted");
    assert.equal(t.board.pins[0].pages.length, 1);
  } finally { await t.fake.close(); }
});

test("resumed topic deleted on the board -> edit skipped_not_found -> next poll matches again (fresh -add name)", async () => {
  const t = await setup({ since: HOUR_AGO() });
  try {
    await t.poller.cycle(); t.inbox.processAll(); await t.poller.cycle();
    await append(t, QUIET, [{ sender: "human", minAgo: 11, message: "One more thing: mulch on top of the soil." }]);
    await t.poller.cycle();
    const edit = t.inbox.puts[1];
    t.inbox.process(edit.name, { status: "skipped_not_found", matched: { pinTitle: null } });
    t.board.pins.length = 0; // the topic was deleted by hand
    await t.poller.cycle();
    const last = t.inbox.puts.at(-1);
    assert.equal(last.cmd.op, "add"); assert.match(last.name, /-add\.json$/);
    assert.equal(last.name.replace(/-add\.json$/, ""), edit.name.replace(/-edit\.json$/, ""), "same conv+timestamp, different op suffix");
  } finally { await t.fake.close(); }
});

test("two chats matching the same topic in one poll: the second waits until the first result is in", async () => {
  const t = await setup({ since: new Date(Date.now() - 4 * 86400_000).toISOString(), topics: [GARDEN], summarizer: fakeSummarizer({ match: "Garden Beds" }) });
  try {
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 1, "second chat deferred (topic busy)");
    t.inbox.processAll(); await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 2);
    const mg = t.summarizer.calls.filter(c => c.op === "merge");
    assert.equal(mg[1].current, t.inbox.puts[0].cmd.body, "the second merge starts from the first merge's result");
  } finally { await t.fake.close(); }
});

test("model lock held (e.g. --compact running) -> the loop defers without error", async () => {
  const t = await setup({ since: HOUR_AGO() });
  try {
    fs.writeFileSync(path.join(t.dir, "model.lock"), String(process.pid)); // a live pid holds it
    const r = await t.poller.cycle();
    assert.equal(r.ok, true); assert.equal(r.counts.deferred, 1); assert.equal(t.inbox.puts.length, 0);
    fs.rmSync(path.join(t.dir, "model.lock"));
    await t.poller.cycle();
    assert.equal(t.inbox.puts.length, 1);
    assert.ok(!fs.existsSync(path.join(t.dir, "model.lock")), "released after use");
  } finally { await t.fake.close(); }
});

test("needs_attention on skipped_ambiguous; reset bumps retry -> -r1 file name", async () => {
  const t = await setup({ since: HOUR_AGO() });
  try {
    await t.poller.cycle();
    t.inbox.process(t.inbox.puts[0].name, { status: "skipped_ambiguous" });
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
  const t = await setup({ since: HOUR_AGO() });
  try {
    await t.poller.cycle();
    const p2 = P.createPoller({ cfg: t.cfg, reader: t.reader, summarizer: t.summarizer, inbox: t.inbox, board: t.board });
    await p2.cycle();
    assert.equal(t.inbox.puts.length, 1);
    fs.rmSync(path.join(t.dir, "state.json")); // lost state: deterministic name + push-if-absent still refuse a duplicate
    const p3 = P.createPoller({ cfg: t.cfg, reader: t.reader, summarizer: t.summarizer, inbox: t.inbox, board: t.board });
    p3.state.since = HOUR_AGO();
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
  let gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", fetchFn: mk([[/GET .*inbox\/results\/a\.json\?ref=inbox$/, () => Response.json({ content: b64({ status: "ok" }) })]]) });
  assert.deepEqual(await gh.pushIfAbsent("a.json", { op: "add" }), { state: "processed", result: { status: "ok" } });
  assert.ok(!calls.some(c => c.method === "PUT"));
  calls.length = 0;
  gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", fetchFn: mk([[/GET .*contents\/inbox\/a\.json\?ref=inbox$/, () => Response.json({ content: b64({ op: "add" }) })]]) });
  assert.deepEqual(await gh.pushIfAbsent("a.json", { op: "add" }), { state: "waiting" });
  calls.length = 0; let n = 0;
  gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", backoffMs: 1, fetchFn: mk([[/PUT /, () => (n++ ? Response.json({ commit: { sha: "deadbeef" } }, { status: 201 }) : new Response("{}", { status: 409 }))]]) });
  const cmd = { op: "add", pin: "Poller test", title: "x", body: "y" };
  assert.deepEqual(await gh.pushIfAbsent("b.json", cmd), { state: "pushed", commit: "deadbeef" });
  const puts = calls.filter(c => c.method === "PUT");
  assert.equal(puts.length, 2);
  assert.match(puts.at(-1).url, /\/repos\/o\/r\/contents\/inbox\/b\.json$/);
  const pb = JSON.parse(puts.at(-1).body);
  assert.equal(pb.branch, "inbox"); assert.deepEqual(JSON.parse(Buffer.from(pb.content, "base64").toString()), cmd);
  gh = P.createGithubInbox({ token: "t", repo: "o/r", branch: "inbox", fetchFn: mk([[/PUT /, () => new Response("{}", { status: 401 })]]) });
  await assert.rejects(gh.pushIfAbsent("c.json", cmd), e => e.kind === "push");
});

test("commands match post.mjs: allowed fields, limits, exact day/pin for edits", () => {
  const add = P.addCommand({ date: "2026-10-11", pin: "Garden", body: "x".repeat(6000) });
  assert.deepEqual(Object.keys(add).sort(), ["body", "date", "op", "pin", "title"]); assert.ok(add.body.length <= 5000);
  const ed = P.editTopicCommand({ date: "2026-10-05", pinTitle: "Garden Beds" }, "b");
  assert.deepEqual(ed, { op: "edit", target: "page", date: "2026-10-05", pin: "Garden Beds", pageNumber: 1, body: "b" });
  const allowed = ["op", "date", "pin", "title", "body", "color", "target", "page", "pageNumber", "newPin"];
  for (const c of [add, ed]) assert.ok(Object.keys(c).every(k => allowed.includes(k)));
});

/* ---------- model ops: match schema, 1,500-char cap ---------- */
function scriptedChat(answers) {
  const seen = [];
  const chat = async req => { seen.push(req); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  return { chat, seen };
}
const TOPICS = [{ pinTitle: "Garden Beds", page1: { body: "- Cedar beds on the south side\n- Soil delivery pending" } }, { pinTitle: "Bike podcast", page1: { body: "Episode ideas: commuting, derailleurs." } }];

test("match: JSON-schema enum = NEW + existing topic names; gists in the prompt; bad answers rejected", async () => {
  let s = scriptedChat([{ subject: "cedar beds", topic: "Garden Beds" }, { answer: "yes" }]);
  assert.deepEqual(await P.createModelOps(s.chat).match(TOPICS, "User: more about the cedar beds"), { topic: "Garden Beds", confirmed: true });
  assert.deepEqual(s.seen[0].schema.properties.topic.enum, ["NEW", "Garden Beds", "Bike podcast"]);
  assert.deepEqual(s.seen[0].schema.required, ["subject", "topic"]);
  assert.match(s.seen[0].user, /- Garden Beds: Cedar beds on the south side/);
  assert.match(s.seen[1].user, /A: cedar beds\nB: Garden Beds \(Cedar beds on the south side/);
  assert.deepEqual(s.seen[1].schema.properties.answer.enum, ["yes", "no"]);
  s = scriptedChat([{ subject: "taxes", topic: "NEW" }]);
  assert.deepEqual(await P.createModelOps(s.chat).match(TOPICS, "User: taxes"), { topic: "NEW", confirmed: null });
  assert.equal(s.seen.length, 1, "NEW needs no confirmation");
  s = scriptedChat([{ topic: "Something else" }]);
  await assert.rejects(P.createModelOps(s.chat).match(TOPICS, "x"), e => e.kind === "summarizer");
  s = scriptedChat([]);
  assert.deepEqual(await P.createModelOps(s.chat).match([], "x"), { topic: "NEW" }); assert.equal(s.seen.length, 0, "no topics: no model call");
});

test("match: the model's pick is kept when confirmation says no but the chat clearly shares the topic's words", async () => {
  const T2 = [{ pinTitle: "Poller test topic", date: "2026-10-11", page1: { body: "- Plot 7 at Maple Street community garden.\n- Vegetables: peppers, zucchini, lettuce." } },
    { pinTitle: "Bike podcast", date: "2026-10-04", page1: { body: "- Episode ideas: commuting tips." } }];
  const chat = "User: On plot 7 at the Maple Street garden I swapped zucchini for tomatoes.";
  assert.ok(P.sharedWords(chat, T2[0]) >= P.MATCH_MIN_SHARED); assert.equal(P.sharedWords(chat, T2[1]), 0);
  let s = scriptedChat([{ subject: "garden plot", topic: "Poller test topic" }, { answer: "no" }, { answer: "no" }]);
  assert.deepEqual(await P.createModelOps(s.chat).match(T2, chat), { topic: "Poller test topic", confirmed: true, by: "overlap" });
  // too little overlap (1-2 words) stays NEW
  s = scriptedChat([{ subject: "street parking", topic: "Poller test topic" }, { answer: "no" }, { answer: "no" }]);
  assert.equal((await P.createModelOps(s.chat).match(T2, "User: parking on Maple Street is full today.")).topic, "NEW");
  assert.equal(P.topicWords("User: Grok, today we need the hoses before Tuesday").has("today"), false);
  assert.equal(P.topicWords("hoses").has("hos"), true, "plural folded");
});

test("match: a pick the confirmation rejects becomes NEW (bias against merging into an unrelated paper)", async () => {
  const lines = [];
  let s = scriptedChat([{ subject: "garden plot", topic: "Garden Beds" }, { answer: "no" }, { answer: "yes" }]);
  assert.deepEqual(await P.createModelOps(s.chat).match(TOPICS, "User: plot"), { topic: "Garden Beds", confirmed: true, by: "summary" });
  assert.doesNotMatch(s.seen[2].user, /B: Garden Beds/, "second opinion: summary text without the pin name");
  s = scriptedChat([{ subject: "car oil change", topic: "Bike podcast" }, { answer: "no" }, { answer: "no" }]);
  const r = await P.createModelOps(s.chat, { log: (lvl, msg, f) => lines.push(JSON.stringify({ msg, ...f })) }).match(TOPICS, "User: oil change for the car");
  assert.equal(s.seen.length, 3);
  assert.deepEqual(r, { topic: "NEW", confirmed: false, rejected: "Bike podcast" });
  assert.ok(lines.some(l => l.includes("match rejected")));
  assert.ok(!lines.join("\n").includes("oil change"), "the subject (message-derived) is never logged");
});

test("dedupeText: a model loop of repeated sentences/lines collapses to one copy before the cap check", async () => {
  assert.equal(P.dedupeText("A one. Tasks: x. Tasks: x. B two.\n- a b\n- A B.\n- c\n- c\n\nZ."), "A one. Tasks: x. B two.\n- a b\n- c\n\nZ.");
  const loop = "Plot 7. " + "Tasks: buy hose. Watering: Tuesday. ".repeat(60);
  const s = scriptedChat([{ body: loop }]);
  const r = await P.createModelOps(s.chat).merge("Garden", "old", "new");
  assert.equal(r.body, "Plot 7. Tasks: buy hose. Watering: Tuesday."); assert.equal(r.reasked, false); assert.equal(s.seen.length, 1);
});

const para = (n, word = "Fact") => Array.from({ length: n }, (_, i) => `- ${word} ${i}: the cedar bed needs more soil before planting.`).join("\n"); // ~57 chars/line

test("merge cap: <= 1,500 accepted as is; over -> re-ask once with stricter wording; still over -> cut at a boundary", async () => {
  let s = scriptedChat([{ body: para(20) }]);
  let r = await P.createModelOps(s.chat).merge("Garden", "old", "new");
  assert.ok(r.body.length <= 1500); assert.equal(r.reasked, false); assert.equal(s.seen.length, 1);
  assert.match(s.seen[0].system, /HARD LIMIT: at most 1500 characters/); assert.match(s.seen[0].user, /CURRENT SUMMARY:\nold/);

  s = scriptedChat([{ body: para(40) }, { body: para(18) }]);
  r = await P.createModelOps(s.chat).merge("Garden", "old", "new");
  assert.equal(r.reasked, true); assert.equal(r.truncated, false); assert.equal(r.firstLength, para(40).length); assert.ok(r.length <= 1500);
  assert.match(s.seen[1].user, /over the hard limit\. Rewrite it in at most 1200 characters/);

  s = scriptedChat([{ body: para(40) }, { body: para(35) }]);
  r = await P.createModelOps(s.chat).merge("Garden", "old", "new");
  assert.equal(r.reasked, true); assert.equal(r.truncated, true); assert.ok(r.body.length <= 1500);
  assert.ok(r.body.endsWith("planting."), "cut at a bullet boundary, not mid-sentence");
  assert.equal(s.seen.length, 2, "re-asks only once");
});

test("truncateAtBoundary: sentence / line boundaries, never over the cap", () => {
  const sents = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const c = P.truncateAtBoundary(sents, 300);
  assert.ok(c.length <= 300 && c.endsWith(".")); assert.ok(!c.endsWith(" "));
  const word = "x".repeat(2000);
  assert.ok(P.truncateAtBoundary(word, 1500).length <= 1500);
  assert.equal(P.truncateAtBoundary("short", 1500), "short");
});

test("summarizeNew and compact are capped too", async () => {
  let s = scriptedChat([{ pin: "Garden", title: "Bed plan", body: para(40) }, { body: para(10) }]);
  const n = await P.createModelOps(s.chat).summarizeNew("t");
  assert.ok(n.body.length <= 1500); assert.equal(n.pin, "Garden");
  s = scriptedChat([{ body: para(17) }]);
  const c = await P.createModelOps(s.chat).compact("Garden", para(40), 1000);
  assert.ok(c.body.length <= 1500); assert.match(s.seen[0].user, /about 1000 characters/);
});

test("salvageBody: a JSON body cut off by max_tokens is recovered", () => {
  assert.deepEqual(P.salvageBody('{"body": "- one\\n- two \\"q\\" and mo'), { body: '- one\n- two "q" and mo' });
  assert.deepEqual(P.salvageBody('{"body": "abc\\'), { body: "abc" });
  assert.equal(P.salvageBody('{"pin": "x"'), null);
});

/* ---------- board reading / topics sorting ---------- */
test("topics: page 1 = first by position, sorted by last update (pin or any page), newest first", () => {
  const rows = [
    { id: "a", title: "Old topic", created_at: "2026-10-01T10:00:00+00:00", updated_at: "2026-10-01T10:00:00+00:00", day: { board_date: "2026-10-01" },
      pages: [{ id: "a2", body: "second", position: 1, created_at: "2026-10-01T10:00:00+00:00", updated_at: "2026-10-01T10:00:00+00:00" },
              { id: "a1", body: "first", position: 0, created_at: "2026-10-01T10:00:00+00:00", updated_at: "2026-10-09T08:00:00+00:00" }] },
    { id: "b", title: "Newer pin", created_at: "2026-10-05T10:00:00+00:00", updated_at: "2026-10-05T10:00:00+00:00", day: { board_date: "2026-10-05" }, pages: [] },
    { id: "c", title: "Renamed", created_at: "2026-09-01T10:00:00+00:00", updated_at: "2026-10-10T10:00:00+00:00", day: { board_date: "2026-09-01" }, pages: [] },
  ];
  const t = P.topicsFromRows(rows);
  assert.deepEqual(t.map(x => x.pinTitle), ["Renamed", "Old topic", "Newer pin"], "an edit of page 1 on Oct 9 lifts an old topic above a newer pin");
  assert.equal(t[1].page1.body, "first"); assert.equal(t[1].date, "2026-10-01"); assert.equal(t[2].page1, null);
});

test("board config: parsed from the public config.js; non-anon keys refused", async () => {
  const jwt = role => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;
  const dir = tmp(), f = path.join(dir, "config.js");
  fs.writeFileSync(f, `window.POSTIT_CONFIG = {\n  SUPABASE_URL: "https://example.supabase.co/",\n  SUPABASE_ANON_KEY: "${jwt("anon")}",\n};`);
  assert.deepEqual(await P.loadBoardConfig({ BOARD_CONFIG: f }), { url: "https://example.supabase.co", anonKey: jwt("anon") });
  await assert.rejects(P.loadBoardConfig({ BOARD_SUPABASE_URL: "https://x", BOARD_SUPABASE_ANON_KEY: jwt("service_role") }), /not the public anon key/);
  const seen = [];
  const b = P.createBoardReader({ config: { url: "https://x", anonKey: "k" }, fetchFn: async (u, i) => { seen.push({ u, i }); return Response.json([]); } });
  assert.deepEqual(await b.listTopics(), []);
  assert.match(seen[0].u, /\/rest\/v1\/pins\?select=.*day:days\(board_date\).*pages\(/); assert.equal(seen[0].i.method, undefined, "GET only");
  const bad = P.createBoardReader({ config: { url: "https://x", anonKey: "k" }, fetchFn: async () => new Response("", { status: 500 }) });
  await assert.rejects(bad.listTopics(), e => e.kind === "board");
});

/* ---------- weekly compaction ---------- */
function compactSetup({ topics, summarizer = fakeSummarizer(), lockHeld = false, pending = false } = {}) {
  const dir = tmp(), cfg = cfgFor(dir);
  const board = fakeBoard(topics), inbox = memInbox(board);
  if (lockHeld) fs.writeFileSync(path.join(dir, "model.lock"), String(process.pid));
  if (pending) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ conversations: { x: { pending: { file: "f" } } } }));
  return { dir, cfg, board, inbox, summarizer };
}
const LONG = { pinTitle: "Long topic", date: "2026-10-06", pages: ["a".repeat(1600)] };
const SHORT = { pinTitle: "Short topic", date: "2026-10-06", pages: ["b".repeat(900)] };
const LONG_WELCOME = { pinTitle: "Post-it Board", date: "2026-10-05", pages: ["w".repeat(2000)] };

test("compaction: selects only topics over the threshold (excluded ones never), dry run pushes nothing", async () => {
  const c = compactSetup({ topics: [LONG, SHORT, LONG_WELCOME] });
  const dryInbox = P.createDryRunInbox(path.join(c.dir, "dry-run", "compact"));
  const r = await P.runCompaction({ cfg: c.cfg, board: c.board, summarizer: c.summarizer, inbox: dryInbox, dryRun: true, threshold: 1500, target: 1000, pollMs: 1 });
  assert.equal(r.checked, 2); assert.equal(r.over, 1); assert.equal(r.compacted, 1); assert.equal(r.failed, 0);
  assert.deepEqual(r.topics.map(t => [t.pin, t.before, t.after, t.status]), [["Long topic", 1600, 1000, "dry_run"]]);
  const f = fs.readdirSync(path.join(c.dir, "dry-run", "compact", "inbox")).filter(x => x.endsWith(".json"));
  assert.equal(f.length, 1); assert.match(f[0], /^compact-[0-9a-f]{10}-\d{8}T\d{6}Z\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.dir, "dry-run", "compact", "inbox", f[0]))), { op: "edit", target: "page", date: "2026-10-06", pin: "Long topic", pageNumber: 1, body: "a".repeat(1000) });
  assert.equal(c.board.pins[0].pages[0].body.length, 1600, "board untouched");
  assert.match(P.formatCompactionReport(r), /topics checked: 2, over threshold: 1, compacted: 1/);
  // configurable threshold
  const r2 = await P.runCompaction({ cfg: c.cfg, board: c.board, summarizer: c.summarizer, inbox: dryInbox, dryRun: true, threshold: 800, pollMs: 1 });
  assert.equal(r2.over, 2);
});

test("compaction: real mode pushes edits and waits for results; not-shorter rewrites are skipped", async () => {
  const c = compactSetup({ topics: [LONG] });
  const auto = { ...c.inbox, async pushIfAbsent(n, cmd) { const p = await c.inbox.pushIfAbsent(n, cmd); c.inbox.process(n); return p; } };
  const r = await P.runCompaction({ cfg: c.cfg, board: c.board, summarizer: c.summarizer, inbox: auto, threshold: 1500, pollMs: 1 });
  assert.equal(r.compacted, 1); assert.equal(r.topics[0].status, "ok"); assert.equal(c.board.pins[0].pages[0].body.length, 1000);
  const c2 = compactSetup({ topics: [LONG], summarizer: fakeSummarizer({ compactBody: "a".repeat(1700) }) });
  const r2 = await P.runCompaction({ cfg: c2.cfg, board: c2.board, summarizer: c2.summarizer, inbox: c2.inbox, threshold: 1500, pollMs: 1 });
  assert.equal(r2.topics[0].status, "skipped_not_shorter"); assert.equal(c2.inbox.puts.length, 0);
});

test("compaction never collides with the loop: skips when the model lock is held or the loop has a pending command", async () => {
  let c = compactSetup({ topics: [LONG], lockHeld: true });
  let r = await P.runCompaction({ cfg: c.cfg, board: c.board, summarizer: c.summarizer, inbox: c.inbox, lockWaitMs: 20, pollMs: 5 });
  assert.match(r.skipped, /model busy/); assert.equal(c.board.reads, 0); assert.equal(c.inbox.puts.length, 0);
  c = compactSetup({ topics: [LONG], pending: true });
  r = await P.runCompaction({ cfg: c.cfg, board: c.board, summarizer: c.summarizer, inbox: c.inbox, lockWaitMs: 20, pollMs: 5 });
  assert.match(r.skipped, /waiting for its result/); assert.ok(!fs.existsSync(path.join(c.dir, "model.lock")), "lock released");
  // --compact CLI exit code 75 when skipped
  c = compactSetup({ topics: [], lockHeld: true });
  const p = spawnSync(process.execPath, [path.join(here, "../poller.mjs"), "--compact", "--dry-run", "--lock-wait", "0.05"], { env: { ...process.env, POLLER_HOME: c.dir, BOARD_SUPABASE_URL: "http://127.0.0.1:9", BOARD_SUPABASE_ANON_KEY: "sb_publishable_x" }, encoding: "utf8" });
  assert.equal(p.status, 75); assert.match(p.stdout, /SKIPPED: model busy/);
});

/* ---------- health classification ---------- */
async function healthAfter(mode, readerOpts = {}) {
  const t = await setup({ mode, since: new Date(Date.now() - 3600_000).toISOString() });
  try {
    const reader = readerOpts.reader || t.reader;
    const poller = P.createPoller({ cfg: t.cfg, reader, summarizer: t.summarizer, inbox: t.inbox, board: t.board });
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
    const p2 = P.createPoller({ cfg: t.cfg, reader: t.reader, summarizer: fakeSummarizer(), inbox: t.inbox, board: t.board });
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
    const poller = P.createPoller({ cfg, reader: P.createRestReader({ baseUrl: fake.url, cookie: "sso=SECRETCOOKIE123" }), summarizer: fakeSummarizer(), inbox: memInbox(), board: fakeBoard(), log: P.makeLogger(logFile, { echo: false }) });
    await P.pollOnce(poller, cfg, P.makeLogger(logFile, { echo: false }));
    const log = fs.readFileSync(logFile, "utf8");
    for (const bad of ["SECRETCOOKIE123", "garden bed", "tomatoes", "cedar", "off the record", QUIET, OPTOUT]) assert.ok(!log.toLowerCase().includes(bad.toLowerCase()), `leaked: ${bad}`);
    assert.ok(log.includes(P.convKey(QUIET)), "hashed key is logged instead");
    assert.ok(log.includes("writing topic"));
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
