// Real-model check of the topic-paper flow on SYNTHETIC chats: NEW summary, match / NEW, merge, cap, compaction.
//   node poller/test/model-merge.mjs     (starts the local llama-server once, ~1-3 min)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../poller.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const chat = f => {
  const c = JSON.parse(fs.readFileSync(path.join(here, "fixtures", f), "utf8")).conversations[0];
  return P.formatTranscript(c.messages.map(m => ({ sender: m.sender, text: m.message })));
};
const cfg = P.loadConfig({}, []);
const timed = async (label, fn) => { const t = Date.now(); try { const r = await fn(); out.push({ step: label, ms: Date.now() - t, ...r }); return r; } catch (e) { out.push({ step: label, ms: Date.now() - t, error: e.message }); return {}; } };
const out = [];
const long = fs.readFileSync("/workspace/llm/transcript_long.txt", "utf8");
const bigSummary = Array.from({ length: 30 }, (_, i) => `- Item ${i + 1}: buy supplies for plot 7 and check the shared tool shed on Maple Street.`).join("\n"); // ~2,400 chars

const { stats } = await P.createLlamaSummarizer(cfg).withModel(8192, async ops => {
  const v1 = await timed("new topic from chat 1", async () => { const s = await ops.summarizeNew(chat("topic-chat-1.json")); return { pin: s.pin, chars: s.body.length, reasked: s.reasked, body: s.body }; });
  const topics = [
    { pinTitle: "Garden plot", page1: { body: v1.body } },
    { pinTitle: "Bike podcast", page1: { body: "- Episode ideas: commuting tips, derailleur history, bike-packing gear." } },
    { pinTitle: "Tax documents", page1: { body: "- Collect the 1099 forms and the property tax receipt before April." } },
  ];
  await timed("match chat 2 (same subject)", async () => ops.match(topics, chat("topic-chat-2.json")));
  await timed("match unrelated chat", async () => ops.match(topics, chat("topic-chat-other.json")));
  await timed("match chat 2 to a pin whose name says nothing ('Poller test topic')", async () => ops.match([{ pinTitle: "Poller test topic", page1: { body: v1.body } }], chat("topic-chat-2.json")));
  // small match-accuracy suite: a wrong topic is a failure; a missed match (NEW) only costs a duplicate pin
  await timed("match accuracy (8 synthetic chats)", async () => {
    const cases = [[chat("topic-chat-2.json"), "Garden plot"], [chat("topic-chat-other.json"), "NEW"],
      ["User: Remind me to renew my passport, it expires in June.\nGrok: Noted, renew the passport before June.", "NEW"],
      ["User: For the podcast, let's add an episode on e-bikes.\nGrok: E-bikes episode added.", "Bike podcast"],
      ["User: What should I cook for dinner tonight? Maybe pasta.\nGrok: Pasta with garlic and spinach is quick.", "NEW"],
      ["User: I found the 1099 from my bank, still missing the property tax receipt.\nGrok: Good, one left.", "Tax documents"],
      ["User: The zucchini on my plot got powdery mildew.\nGrok: Remove the affected leaves and water at the base.", "Garden plot"],
      ["User: Did my car's oil change, next one at 45,000 miles.\nGrok: Noted.", "NEW"]];
    let correct = 0, wrongTopic = 0, missed = 0;
    for (const [t, exp] of cases) { const { topic } = await ops.match(topics, t); if (topic === exp) correct++; else if (topic === "NEW") missed++; else wrongTopic++; }
    if (wrongTopic) throw new Error(`${wrongTopic} chat(s) matched the wrong topic`);
    return { correct, missed, wrongTopic, of: cases.length };
  });
  await timed("merge chat 2 into topic", async () => { const m = await ops.merge("Garden plot", v1.body, chat("topic-chat-2.json")); return { chars: m.body.length, firstLength: m.firstLength, reasked: m.reasked, truncated: m.truncated, body: m.body }; });
  await timed("merge long transcript into a 2,400-char summary (cap stress)", async () => { const m = await ops.merge("Garden plot", bigSummary, long); return { chars: m.body.length, firstLength: m.firstLength, reasked: m.reasked, truncated: m.truncated }; });
  await timed("compact 2,400 chars -> ~1,000", async () => { const c = await ops.compact("Garden plot", bigSummary, 1000); return { before: bigSummary.length, chars: c.body.length, reasked: c.reasked, truncated: c.truncated }; });
});
console.log(JSON.stringify({ steps: out, session: stats }, null, 2));
const bad = out.filter(s => s.chars > P.TOPIC_CAP || s.error);
if (bad.length) { console.error("OVER CAP:", bad.map(b => b.step)); process.exit(1); }
