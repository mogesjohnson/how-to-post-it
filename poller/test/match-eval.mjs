// Real-model topic-matching evaluation on SYNTHETIC chats (test/fixtures/match-suite.json).
//   node poller/test/match-eval.mjs [--json] [--only <case-id substring>]
// Prints per case: expected / got / how, then totals: correct, missed (a follow-up became NEW: costs a
// duplicate pin) and WRONG (merged into the wrong topic, or an unrelated chat merged: never acceptable).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../poller.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "match-suite.json"), "utf8"));
const args = P.parseArgs(process.argv.slice(2));
const topics = suite.topics.map((t, i) => ({ pinTitle: t.pinTitle, date: "2026-10-0" + (i + 1), pageNumber: 1, page1: { body: t.body } }));
const cases = suite.cases.filter(c => !args.only || c.id.includes(args.only));
const rows = [];
const t0 = Date.now();
const { stats } = await P.createLlamaSummarizer(P.loadConfig({}, [])).withModel(8192, async ops => {
  for (const c of cases) {
    const t = Date.now();
    let r; try { r = await ops.match(topics, c.chat); } catch (e) { r = { topic: "ERROR", error: e.message }; }
    const got = r.topic;
    const verdict = got === c.expect ? "correct" : got === "NEW" ? "missed" : "WRONG";
    rows.push({ id: c.id, hard: !!c.hard, expect: c.expect, got, by: r.by || (r.confirmed === false ? `rejected:${r.rejected}` : ""), verdict, ms: Date.now() - t });
  }
});
const n = k => rows.filter(r => r.verdict === k).length;
const fu = rows.filter(r => r.expect !== "NEW"), neg = rows.filter(r => r.expect === "NEW");
const totals = {
  cases: rows.length, correct: n("correct"), missed: n("missed"), wrong: n("WRONG"),
  followUpsMatched: `${fu.filter(r => r.verdict === "correct").length}/${fu.length}`,
  unrelatedKeptNew: `${neg.filter(r => r.verdict === "correct").length}/${neg.length}`,
  avgMs: Math.round(rows.reduce((a, r) => a + r.ms, 0) / Math.max(1, rows.length)), totalMs: Date.now() - t0, calls: stats.calls,
};
if (args.json) console.log(JSON.stringify({ totals, rows }, null, 2));
else {
  for (const r of rows) console.log(`${r.verdict.padEnd(7)} ${r.id.padEnd(20)} ${r.hard ? "hard" : "    "} expect=${r.expect.padEnd(14)} got=${r.got.padEnd(14)} ${r.by} ${r.ms}ms`);
  console.log(JSON.stringify(totals));
}
process.exit(totals.wrong ? 1 : 0);
