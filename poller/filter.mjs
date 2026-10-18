// Throwaway-chat filter (issue #11): decide, BEFORE anything is summarized or posted, whether a finished voice chat
// is worth a note. Directions, weather, quick lookups, timers, music and greetings-only chats are skipped.
//
// Two stages, cheapest first:
//   1. prefilter(msgs, cfg)  keywords/heuristics on the USER's turns, no model call -> "skip" | "keep" | "ask"
//   2. ops.classify(...)     only for "ask" (little real content left after stage 1): one small local-model call
//                            with a JSON schema {category, keep}; skipped only when the category is an enabled
//                            throwaway category (never "topic").
// A wrong skip loses a note, a wrong keep only costs a small one, so every rule leans towards KEEP:
//   - a long user turn that merely mentions a keyword ("navigate to the lumber yard, I need cedar boards for the
//     garden bed") is not throwaway;
//   - enough other content (>= askBelowWords words) is kept without asking the model (mixed chats);
//   - reminders / to-dos are never a skip category ("remind me to ..." is a real note).
// Privacy: the decision carries counts and a category only, never words from the chat.
import fs from "node:fs";

export const CATEGORIES = ["directions", "weather", "lookup", "timer", "media", "greeting", "short"];
export const FILTER_DEFAULTS = { skip: CATEGORIES.slice(), model: true, minWords: 6, askBelowWords: 25, maxThrowawayTurnWords: 16, keywords: {} };

// a user turn is classified by these; patterns run on a lower-cased, apostrophe-normalized turn
export const PATTERNS = {
  directions: [
    /\b(navigate|navigation|directions?|reroute|re-route|detour|gps)\b/,
    /\btake me (to|home)\b/, /\b(route|drive|get) (me )?(to|home)\b/, /\bhow (do i|can i|to) get (to|there|home)\b/,
    /\bhow far (is|to|away)\b/, /\bhow long (until|till|to get|will it take)\b/, /\b(eta|arrival time)\b/,
    /\btraffic\b/, /\bavoid (tolls|highways|the highway)\b/, /\b(next|which) exit\b/, /\bturn (left|right)\b/,
    /\b(nearest|closest|nearby)\b/, /\bgas station\b|\bcharging station\b|\bcharger near\b/, /\bwhere is the\b.*\b(near|around)\b/,
    /\bparking (near|nearby|around)\b/, /\bfind (me )?(a|the|some) .*(near|around|on the way)\b/,
  ],
  weather: [
    /\bweather\b/, /\bforecast\b/, /\b(is it|will it|going to|gonna) (rain|snow|storm|be (hot|cold|sunny|windy))\b/,
    /\b(rain|raining|snowing|thunderstorm)\b.*\b(today|tonight|tomorrow|later|outside)\b/, /\btemperature (outside|today|tomorrow)\b/,
    /\bhow (hot|cold|warm) (is it|will it be)\b/, /\bdo i need an umbrella\b/, /\bdegrees (outside|out)\b/,
  ],
  timer: [/\b(set|start|cancel|stop) (a |an |the |my )?(timer|alarm|stopwatch|countdown)\b/, /\btimer for\b/, /\bwake me up\b/, /\bhow much time is left\b/],
  media: [
    /\bplay (some|the|a|my|me)?\s*(music|song|songs|album|playlist|podcast|radio|station|track)\b/, /\bplay (something|anything)\b/, /^play\b/,
    /\b(pause|resume|unpause|shuffle|repeat) (the )?(music|song|playback|podcast|radio)\b/, /^(pause|resume|unpause|shuffle)( it| this| that)?$/,
    /\b(skip|next|previous) (this |the )?(song|track)\b/, /\b(volume|turn it (up|down)|turn (up|down) the (music|volume|radio))\b/,
    /\b(spotify|apple music|pandora|youtube music|siriusxm)\b/, /\bwhat (song|track) is (this|playing)\b/,
  ],
  lookup: [
    /^(what|who|when|where|which)('s| is| was| are| were| did| does)\b/, /^how (many|much|old|tall|big|long|far|deep|high)\b/,
    /^(what time is it|what day is it|what's the date)\b/, /\b(score|final score|who won|stock price|share price|exchange rate)\b/,
    /\bconvert\b.*\b(to|into)\b/, /\bhow do you (spell|pronounce)\b/, /^(define|spell|translate)\b/, /\bwhat does .* mean\b/,
    /\bhow many (ounces|cups|grams|miles|kilometers|feet|inches|pounds|teaspoons|tablespoons)\b/,
  ],
};
// greetings / filler / acknowledgements: neutral turns that carry no topic
const FILLER = /^(hi|hey|hello|yo|good (morning|afternoon|evening|night)|morning|thanks?( you)?( so much)?|thank you|thx|ok(ay)?|k|yes|yeah|yep|no|nope|sure|cool|great|nice|awesome|perfect|got it|sounds good|alright|all right|bye|goodbye|see you|later|never ?mind|nothing|how are you( doing)?|what's up|sup|hmm+|um+|uh+|hey grok|hi grok|hello grok|grok|that's (all|it)|i'm good|you too|cheers|wow|lol|haha|right|exactly|true|go ahead|stop|cancel|wait)$/;
// planning words: a short question with these is about the user's own plans, not a lookup
const PLANNING = /\b(i|i'm|i'll|i've|my|we|we're|we'll|our|us|let's|remind|reminder|plan|planning|need|want|should|todo|to-do|list|idea|project|decide|decided|budget|schedule|book|buy|order|call|email|meeting)\b/;

const normTurn = s => String(s || "").toLowerCase().replace(/[’`]/g, "'").replace(/<[^>]{1,200}>/g, " ").replace(/[^a-z0-9'?\s-]/g, " ").replace(/\s+/g, " ").trim();
const words = s => (s ? s.replace(/\?/g, " ").split(" ").filter(Boolean).length : 0);
// "hey grok thanks" / "ok thank you bye": strip known filler phrases from the front (longest first) until nothing is left
const fillerOnly = t => {
  let rest = t.replace(/[?,]/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; rest && i < 12; i++) {
    const w = rest.split(" ");
    let n = Math.min(4, w.length);
    for (; n >= 1; n--) if (FILLER.test(w.slice(0, n).join(" "))) break;
    if (!n) return false;
    rest = w.slice(n).join(" ").replace(/^(and|so|then)\b\s*/, "");
  }
  return !rest;
};

// one user turn -> {kind: "filler" | "throwaway" | "other", category?, words, signal?}
export function classifyTurn(text, cfg = FILTER_DEFAULTS) {
  const t = normTurn(text);
  const n = words(t);
  if (!t || fillerOnly(t)) return { kind: "filler", words: n };
  const enabled = new Set(cfg.skip || []);
  const extra = cfg.keywords || {};
  let category = null;
  for (const cat of ["timer", "media", "weather", "directions", "lookup"]) {
    const pats = [...PATTERNS[cat], ...(extra[cat] || []).map(s => new RegExp(s, "i"))];
    if (!pats.some(re => re.test(t))) continue;
    if (cat === "lookup" && (n > 12 || PLANNING.test(t))) continue; // "what should I buy for the garden?" is a plan
    category = cat; break;
  }
  if (!category) return { kind: "other", words: n };
  if (!enabled.has(category)) return { kind: "other", words: n, signal: category }; // category not skipped: real content
  if (n > (cfg.maxThrowawayTurnWords ?? FILTER_DEFAULTS.maxThrowawayTurnWords)) return { kind: "other", words: n, signal: category }; // long turn: keyword in passing
  return { kind: "throwaway", category, words: n };
}

// msgs: [{sender: "human"|"assistant", text}] (the part that would be posted)
// -> {decision: "skip"|"keep"|"ask", category, by: "keywords", turns: {filler, throwaway, other}, otherWords, userWords}
export function prefilter(msgs, cfg = FILTER_DEFAULTS) {
  const user = (msgs || []).filter(m => m.sender === "human");
  const turns = user.map(m => classifyTurn(m.text, cfg));
  const count = k => turns.filter(x => x.kind === k).length;
  const otherWords = turns.filter(x => x.kind === "other").reduce((a, x) => a + x.words, 0);
  const userWords = turns.reduce((a, x) => a + x.words, 0);
  const out = { by: "keywords", turns: { filler: count("filler"), throwaway: count("throwaway"), other: count("other") }, otherWords, userWords };
  const skip = new Set(cfg.skip || []);
  if (!skip.size) return { ...out, decision: "keep", category: null };
  // 1) only greetings / thanks / ok
  if (!user.length || turns.every(x => x.kind === "filler")) return skip.has("greeting") ? { ...out, decision: "skip", category: "greeting" } : { ...out, decision: "keep", category: null };
  // 2) every non-filler user turn is throwaway -> the most frequent category (ties: first in CATEGORIES order)
  if (!out.turns.other) {
    const tally = {};
    for (const x of turns) if (x.kind === "throwaway") tally[x.category] = (tally[x.category] || 0) + 1;
    const category = Object.keys(tally).sort((a, b) => tally[b] - tally[a] || CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))[0];
    return { ...out, decision: "skip", category };
  }
  // 3) very short chat overall (and nothing that looks like a plan)
  if (userWords < (cfg.minWords ?? FILTER_DEFAULTS.minWords) && skip.has("short")) return { ...out, decision: "skip", category: "short" };
  // 4) little real content left: let the model decide (if enabled); otherwise / enough content: keep
  if (cfg.model !== false && otherWords < (cfg.askBelowWords ?? FILTER_DEFAULTS.askBelowWords)) return { ...out, decision: "ask", category: null };
  return { ...out, decision: "keep", category: null };
}

// A KEPT chat that also has throwaway turns ("take me to the lumber yard" + a shelf plan): drop each throwaway user
// turn and Grok's answers to it, so the note is about the real topic, not the route. Never returns an empty list.
export function stripThrowaway(msgs, cfg = FILTER_DEFAULTS) {
  const out = [];
  let dropping = false;
  for (const m of msgs || []) {
    if (m.sender === "human") dropping = classifyTurn(m.text, cfg).kind === "throwaway";
    if (!dropping) out.push(m);
  }
  return out.some(m => m.sender === "human") ? out : msgs;
}

// the model's classification (stage 2): a skip only for an enabled throwaway category, never "topic"
export const CLASSIFY_PROMPT = [
  "You sort finished voice chats between a user and Grok into one category, to decide which ones become notes on the user's notes board.",
  "topic = the user's own plan, project, decision, to-do, reminder, shopping list, idea or event: something to remember or continue later.",
  "directions = navigation, routes, traffic, finding a nearby place. weather = weather or forecast.",
  "lookup = a one-off question answered once (opening hours, a fact, trivia, a definition, a conversion, a score, the time).",
  "timer = timers or alarms. media = playing music, podcasts or radio, volume. greeting = hello, thanks, small talk or a joke.",
  "If ANY part of the chat is the user's own plan, to-do, reminder or idea, the category is topic, even when the rest is directions, weather or a lookup.",
  "keep = true for topic, false for every other category.",
  "Examples: \"Is the pharmacy on Elm open now?\" -> lookup. \"Who wrote Hamlet?\" -> lookup. \"Tell me a joke\" -> greeting.",
  "\"Remind me to call the bakery\" -> topic. \"Add eggs to the grocery list\" -> topic.",
  "\"Navigate home. Also remind me to buy dog food\" -> topic. \"When does the bakery close? I need to pick up Nora's cake\" -> topic.",
].join(" ");
export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: { category: { type: "string", enum: ["topic", ...CATEGORIES.filter(c => c !== "short")] }, keep: { type: "boolean" } },
  required: ["category", "keep"],
  additionalProperties: false,
};
// raw model answer -> {keep, category, by: "model"}
export function interpretClassification(r, cfg = FILTER_DEFAULTS) {
  const category = typeof r?.category === "string" ? r.category : "topic";
  const enabled = new Set(cfg.skip || []);
  // the category decides (a 2B model often says keep: true next to a throwaway category); "topic" is always kept
  const skip = category !== "topic" && enabled.has(category);
  return { keep: !skip, category: skip ? category : null, modelCategory: category, by: "model" };
}

// FILTER_CONFIG (JSON file, default <home>/filter.json if it exists) < env vars. Bad values fall back to defaults.
//   {"skip": ["directions","weather",...], "model": true, "minWords": 6, "askBelowWords": 25, "keywords": {"media": ["\\baudiobook\\b"]}}
//   SKIP_CATEGORIES=directions,weather   (or "none" / "" to turn the filter off)   FILTER_MODEL=0|1
//   FILTER_MIN_WORDS=6   FILTER_ASK_BELOW_WORDS=25
export function loadFilterConfig(env = process.env, home = "") {
  const cfg = { ...FILTER_DEFAULTS, skip: FILTER_DEFAULTS.skip.slice(), keywords: {} };
  const file = env.FILTER_CONFIG || (home ? `${home}/filter.json` : "");
  let source = "defaults";
  if (file && fs.existsSync(file)) {
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`filter config ${file}: not valid JSON`); }
    if (Array.isArray(j.skip)) cfg.skip = j.skip;
    if (typeof j.model === "boolean") cfg.model = j.model;
    for (const k of ["minWords", "askBelowWords", "maxThrowawayTurnWords"]) if (Number.isFinite(j[k])) cfg[k] = j[k];
    if (j.keywords && typeof j.keywords === "object") cfg.keywords = j.keywords;
    source = "file";
  }
  if (env.SKIP_CATEGORIES !== undefined) { cfg.skip = /^\s*(none|off)?\s*$/i.test(env.SKIP_CATEGORIES) ? [] : env.SKIP_CATEGORIES.split(","); source = source === "file" ? "file+env" : "env"; }
  if (env.FILTER_MODEL !== undefined) cfg.model = !/^(0|false|no|off)$/i.test(env.FILTER_MODEL);
  const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
  cfg.minWords = num(env.FILTER_MIN_WORDS, cfg.minWords);
  cfg.askBelowWords = num(env.FILTER_ASK_BELOW_WORDS, cfg.askBelowWords);
  cfg.skip = [...new Set(cfg.skip.map(s => String(s).trim().toLowerCase()).filter(Boolean))];
  const unknown = cfg.skip.filter(c => !CATEGORIES.includes(c));
  if (unknown.length) throw new Error(`filter config: unknown skip categor${unknown.length > 1 ? "ies" : "y"} ${unknown.join(", ")} (known: ${CATEGORIES.join(", ")})`);
  for (const [cat, list] of Object.entries(cfg.keywords)) {
    if (!PATTERNS[cat] || !Array.isArray(list)) throw new Error(`filter config: keywords.${cat} must be a list for one of ${Object.keys(PATTERNS).join(", ")}`);
    for (const s of list) new RegExp(s, "i"); // throws on a bad pattern at start-up, not mid-poll
  }
  cfg.source = source;
  return cfg;
}
