// Real-model check of the throwaway-chat filter on SYNTHETIC chats (starts the local model once, ~1 min).
//   node poller/test/filter-eval.mjs
// Stage 1 (keywords) runs on every chat; chats it sends to the model ("ask") get one classify call.
// The chats differ from the few-shot examples in CLASSIFY_PROMPT (no test leakage).
// Exit 1 if a chat that should be KEPT is skipped (a lost note is the costly mistake).
import * as P from "../poller.mjs";
import * as F from "../filter.mjs";

const H = text => ({ sender: "human", text }), A = text => ({ sender: "assistant", text });
const CHATS = [
  // throwaway
  { want: "skip", name: "directions", msgs: [H("Navigate to the Maple Street hardware store."), A("Starting directions, 12 minutes."), H("How's the traffic?"), A("Light.")] },
  { want: "skip", name: "weather", msgs: [H("What's the weather tomorrow?"), A("Sunny, high of 68."), H("Do I need an umbrella?"), A("No.")] },
  { want: "skip", name: "timer", msgs: [H("Set a timer for 12 minutes for the pasta."), A("Timer set for 12 minutes.")] },
  { want: "skip", name: "media", msgs: [H("Play some jazz."), A("Playing jazz."), H("Turn it up a bit."), A("Done.")] },
  { want: "skip", name: "greeting", msgs: [H("Hey Grok, good morning! How are you?"), A("Great, how can I help?"), H("Nothing, thanks. Bye!")] },
  { want: "skip", name: "store hours (no keyword)", msgs: [H("Is the hardware store on Oak Avenue open on Sundays?"), A("Yes, 10 to 5 on Sundays.")] },
  { want: "skip", name: "joke (no keyword)", msgs: [H("Can you say something funny about dogs for me?"), A("Dogs think every walk is the best day of their life.")] },
  { want: "skip", name: "trivia (no keyword)", msgs: [H("Remind me, who painted the Sistine Chapel ceiling?"), A("Michelangelo.")] },
  { want: "skip", name: "calories (no keyword)", msgs: [H("Calories in a banana?"), A("About 105 calories in a medium banana.")] },
  // keep
  { want: "keep", name: "reminder", msgs: [H("Remind me to renew the car registration this month."), A("Reminder noted.")] },
  { want: "keep", name: "grocery list", msgs: [H("Put batteries and lightbulbs on the hardware list."), A("Added batteries and lightbulbs.")] },
  { want: "keep", name: "short plan", msgs: [H("I want to repaint the porch sage green next weekend."), A("Sage green porch next weekend, noted.")] },
  { want: "keep", name: "mixed short", msgs: [H("Take me to work."), A("Navigating to work, 20 minutes."), H("And remind me to email Priya about the budget."), A("Will do.")] },
  { want: "keep", name: "mixed weather + trip", msgs: [H("What's the weather in Asheville this weekend?"), A("Mild and dry."), H("Good, then we'll book the cabin for Saturday and hike Mount Pisgah."), A("Cabin Saturday, hike Mount Pisgah.")] },
  { want: "keep", name: "idea", msgs: [H("Idea for the podcast: an episode on derailleur history."), A("Nice, noted for the podcast.")] },
  { want: "keep", name: "lookup + errand", msgs: [H("What time does the post office close?"), A("At 5 pm."), H("Okay, I have to mail the passport forms today."), A("Got it.")] },
  { want: "keep", name: "decision", msgs: [H("We decided to go with the blue tiles for the bathroom."), A("Blue tiles for the bathroom, noted.")] },
  { want: "skip", name: "definition (no keyword)", msgs: [H("Quick question, is a tomato a fruit?"), A("Botanically, yes.")] },
  { want: "skip", name: "sports (no keyword)", msgs: [H("Did the Yankees win last night?"), A("Yes, 5 to 3.")] },
  { want: "keep", name: "long topic", msgs: [H("Let's plan Nora's tenth birthday party. I'm thinking of doing it at the community pool on the 14th, with about twelve kids."), A("Sounds fun."), H("Order a chocolate cake from the bakery downtown, and remind me to send the invitations by Friday.")] },
];

const cfg = P.loadConfig({}, []);
const release = P.tryLock(`${cfg.home}/model.lock`);
if (!release) { console.error("model busy (the poller is summarizing); try again in a minute"); process.exit(75); }
const rows = [];
try {
  await P.createLlamaSummarizer(cfg).withModel(4096, async ops => {
    for (const c of CHATS) {
      const pf = F.prefilter(c.msgs, F.FILTER_DEFAULTS);
      let got = pf.decision === "skip" ? "skip" : "keep", by = "keywords", category = pf.category, raw = null, ms = 0;
      if (pf.decision === "ask") {
        const t = Date.now();
        raw = await ops.classify(P.formatTranscript(c.msgs));
        ms = Date.now() - t;
        const d = F.interpretClassification(raw, F.FILTER_DEFAULTS);
        got = d.keep ? "keep" : "skip"; by = "model"; category = d.category;
      }
      rows.push({ name: c.name, want: c.want, got, by, category, model: raw, ms, ok: got === c.want });
    }
  });
} finally { release(); }
for (const r of rows) console.log(JSON.stringify(r));
const lost = rows.filter(r => r.want === "keep" && r.got === "skip").length;
const missed = rows.filter(r => r.want === "skip" && r.got === "keep").length;
console.log(JSON.stringify({ chats: rows.length, correct: rows.filter(r => r.ok).length, wrongSkips: lost, missedSkips: missed, modelCalls: rows.filter(r => r.by === "model").length }));
process.exit(lost ? 1 : 0);
