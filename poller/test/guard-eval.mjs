// Real-model check of the number/time guardrail on SYNTHETIC transcripts.
//   node poller/test/guard-eval.mjs [--runs 2]
// For each transcript, summarizes with the current prompt and with the prompt WITHOUT the
// "copy numbers exactly" sentence, and reports what the guard found in the raw output
// (invented am/pm, unsupported numbers) and whether anything unsupported is left after the guard.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../poller.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = P.parseArgs(process.argv.slice(2));
const runs = Number(args.runs) || 2;
const fx = f => P.formatTranscript(JSON.parse(fs.readFileSync(path.join(here, "fixtures", f), "utf8")).conversations[0].messages.map(m => ({ sender: m.sender, text: m.message })));
const texts = {
  "llm/transcript_short": fs.existsSync("/workspace/llm/transcript_short.txt") ? fs.readFileSync("/workspace/llm/transcript_short.txt", "utf8") : null,
  "topic-chat-1": fx("topic-chat-1.json"),
  "topic-chat-2": fx("topic-chat-2.json"),
  "times-chat": "User: For Saturday, we leave by 11 and the kids' game starts at 1.\nGrok: Got it. Pack lunch?\nUser: Yes, and pick up Grandma around noon. Dinner reservation at 7 in the evening for six people.\nGrok: Noted: leave by 11, Grandma at noon, game at 1, dinner at 7 PM for six.",
};
const OLD_RULE = /Copy numbers, times and dates exactly as they were said: [^)]*\)\. /;
const rows = [];
await P.createLlamaSummarizer(P.loadConfig({}, [])).withModel(8192, async ops => {
  const raw = ops.chat;
  for (const [variant, chat] of [["old prompt", req => raw({ ...req, system: String(req.system).replace(OLD_RULE, "") })], ["new prompt", raw]]) {
    const o = P.createModelOps(chat);
    for (const [name, text] of Object.entries(texts)) {
      if (!text) continue;
      for (let i = 0; i < runs; i++) {
        const t = Date.now();
        const r = await o.summarizeNew(text);
        const left = P.checkNumbers(r.body, text).unsupported.length;
        rows.push({ variant, name, run: i + 1, ms: Date.now() - t, chars: r.body.length, inventedAmPm: r.numbers.meridiemFixed, unsupportedNumbers: r.numbers.unsupported, reasked: r.numbers.numbersReasked, dropped: r.numbers.dropped, leftAfterGuard: left });
      }
    }
  }
});
for (const r of rows) console.log(JSON.stringify(r));
for (const v of ["old prompt", "new prompt"]) {
  const rs = rows.filter(r => r.variant === v);
  const sum = k => rs.reduce((a, r) => a + (r[k] || 0), 0);
  console.log(JSON.stringify({ variant: v, summaries: rs.length, withInventedAmPm: rs.filter(r => r.inventedAmPm).length, inventedAmPm: sum("inventedAmPm"), withUnsupportedNumbers: rs.filter(r => r.unsupportedNumbers).length, unsupportedNumbers: sum("unsupportedNumbers"), dropped: sum("dropped"), leftAfterGuard: sum("leftAfterGuard") }));
}
