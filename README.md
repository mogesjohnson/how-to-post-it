# How to post it 🚗 ➜ 📌

**How conversations with Grok in the car reach the [Post-it Board](https://mogesjohnson.github.io/post-it-board/):**
the recommended transcript automation, Ara's "post it" command, and the architecture behind both.

> **New here? Start with [Documentation - redirection to the specific chat that's pinned in Grok that talks about this whole workflow and our thoughts on it and how we put it all together, and the whole transcription is there](docs/main-workflow-goal.md)**, the whole story of this project on one page.

This is a **documentation and spec repo**. It has no app code and no secrets.

| Doc | What's in it |
|-----|--------------|
| [Documentation - redirection to the specific chat that's pinned in Grok that talks about this whole workflow and our thoughts on it and how we put it all together, and the whole transcription is there](docs/main-workflow-goal.md) | **Start here:** plain-language overview of the whole project |
| [docs/transcript-automation.md](docs/transcript-automation.md) | **Primary path:** read the Grok transcript, detect silence, summarize, push to the inbox. Loop, pseudocode, dedup, failure modes |
| [docs/ara-instructions.md](docs/ara-instructions.md) | Second way: what the car's Grok ("Ara") does when you say "post it" |
| [docs/architecture.md](docs/architecture.md) | Diagrams of all write paths, who does what, failure modes |
| [docs/setup-checklist.md](docs/setup-checklist.md) | The steps you do by hand |
| [docs/risks.md](docs/risks.md) | Honest risks and the list of unverified assumptions |
| [templates/](templates/) | Example command files (add / edit / delete) |
| [scripts/send-test-command.sh](scripts/send-test-command.sh) | Pushes a test command into the board's inbox with `gh` |
| [docs/ai-studio-prompt.md](docs/ai-studio-prompt.md) | *Superseded, optional legacy:* prompt for the old Android voice app |

---

## Goal

Talk to Grok while driving the Tesla and have the conversation land on the board with **zero friction**:

- **automatically:** when a conversation goes quiet, it is summarized and pinned, even if you never said
  "post it", so nothing is lost;
- **on demand:** say **"post it"** and Ara pins the note right away.

One pin per topic, one page per conversation. No screens, no typing, no taps while driving.

## The existing board (already live)

Repo: **[mogesjohnson/post-it-board](https://github.com/mogesjohnson/post-it-board)**. Site: **https://mogesjohnson.github.io/post-it-board/**

- **Site:** static HTML/CSS/vanilla JS on GitHub Pages (from `main` / root). It looks like a classroom
  corkboard: days → pins (topics) → pages (notes).
- **Data:** Supabase (free plan). The tables are `days`, `pins`, `pages` and `board_owners`, all with Row Level Security:
  - the **anon key** in the site's `config.js` is public by design and can only **read**;
  - **writes** are allowed only for signed-in users listed in `public.board_owners`, which today means the human owner and a
    **bot account** (`johnsonmoges+postit-bot@gmail.com`) used by automation;
  - public sign-ups are off;
  - deleting a pin removes its pages too (cascade).
- **Writer:** `scripts/post.mjs` (Node 18+). It does quick-add from the command line and also runs JSON command files.
- **Inbox:** a GitHub Actions workflow (`.github/workflows/inbox.yml`) on the **`inbox` branch of post-it-board**.
  Anything that can push a JSON file to `inbox/<name>.json` there can add, edit or delete notes. The workflow runs
  `scripts/post.mjs --command-file` signed in as the bot (using the encrypted repo secrets `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_OWNER_EMAIL`, `SUPABASE_OWNER_PASSWORD`), writes `inbox/results/<name>.json`,
  removes the command file and pushes the result back.
  Full format: **[post-it-board inbox/README.md (inbox branch)](https://github.com/mogesjohnson/post-it-board/blob/inbox/inbox/README.md)**.

> **Which repo has the inbox?** `mogesjohnson/post-it-board`, branch `inbox`. **Not this repo:** how-to-post-it
> has no `inbox` branch, and files pushed here do nothing. (An earlier request said "how-to-post-it's inbox
> branch"; that was a slip.)

Command format in brief:

```jsonc
{"op": "add"|"edit"|"delete", "date": "YYYY-MM-DD" /* default: today, America/New_York */,
 "pin": "Topic", "title": "page title", "body": "text", "color": "yellow|pink|blue|green",
 "target": "pin"|"page" /* edit/delete */, "page": "exact page title" | "pageNumber": 2, "newPin": "renamed pin"}
```

| status | meaning |
|--------|---------|
| `ok` | done |
| `skipped_duplicate` | the same text was already added to that pin in the last 10 minutes |
| `skipped_ambiguous` | more than one pin or page could match, so nothing changed |
| `skipped_not_found` | the pin, page or day doesn't exist (edit/delete need exact names) |
| `error_invalid` | bad JSON or bad fields |
| `error` | real failure (auth, network, database); the command file is kept for a retry |

**add** ignores case, spaces and punctuation, so "AI" and "ai!" land on the same pin, and a whole-word prefix
matches ("Python lists" → "Python"). Typos are tolerated only inside longer words (5+ letters, same first letter),
so short different words like "Code" and "Node" stay separate pins. Writers should reuse the **exact** topic title
from earlier the same day instead of relying on matching. **edit/delete** need the exact pin title plus a `target`,
and never guess.

## Why the board repo stays public

- **No secrets live in the repo.** Not in post-it-board, not here. The only key in the site code is the anon key,
  which is public by design.
- **Actions secrets are encrypted.** They are never shown in logs (GitHub masks them) and are only
  available to workflows in that repo.
- **Forks can't get the secrets.** Workflows triggered by pull requests from forks don't receive repository secrets, and the
  inbox workflow only runs on pushes to `inbox`, which needs write access.
- **RLS blocks anonymous writes.** The anon key is read-only by design. Writes need a signed-in account listed in
  `public.board_owners`.
- **Never use a `service_role` key.** It bypasses RLS. The inbox signs in as the bot account instead, so RLS
  still applies to every write.
- **GitHub Pages on a private repo needs a paid plan.** Keeping the repo public keeps the board free.
- **The notes are public anyway.** Command and result files are readable in the repo, but they only contain note text,
  which the board shows publicly. **That text also stays in the `inbox` branch's git history:** deleting a note from
  the board doesn't remove it from the repo. Only a history rewrite of the `inbox` branch does, so keep summaries free
  of anything sensitive.

## Ways to post

### 1. Recommended: transcript automation (automatic)

The Grok app on your phone **mirrors the car conversation** with Ara as a live transcript with timestamps. An
automation or script (not Ara herself):

1. periodically reads the conversation transcript;
2. notices when the newest message is older than the **silence threshold** (default **8 s**, tunable **5–30 s**);
3. summarizes the conversation;
4. pushes `inbox/auto-<conversation hash>-<last-message time>.json` to the `inbox` branch of post-it-board, and the
   existing GitHub Action pins it.

If the conversation continues later, the automation sends an `edit` that updates the same page instead of adding a
second one.

- **No phone app, no widget, no foreground service, no xAI API key** for this path.
- It holds only a **fine-grained GitHub token** limited to post-it-board contents. It never holds Supabase credentials;
  only the Action does.
- **Honest caveat:** how the automation actually *reads* your Grok transcript is **unverified**. There is no
  public, documented xAI/Grok API for consumer conversation history. The recommended reader uses grok.com's own
  undocumented `/rest/app-chat/` endpoints with your session cookie (fallback: a signed-in browser profile); both
  are automated access in tension with xAI's terms, and whether *car/voice* conversations return text is untested.
  Options, evidence and tradeoffs are in the doc.
- **Timing:** the threshold is a *minimum* quiet time, checked at each poll. A scheduled job such as GitHub
  Actions cron can't run more often than every 5 minutes, so with cron "8 s" means "at least 8 s of silence,
  noticed at the next run", not "posted within 8 s".

Full design: **[docs/transcript-automation.md](docs/transcript-automation.md)**.

### 2. Ara in the car says "post it" (on demand)

**Untested.** This path assumes the car's built-in Grok ("Ara") has a tool that can create files in GitHub. That is
**unverified**, and no `ara-…` result has appeared in the inbox yet. If it works, when you say **"post it"**, she writes
`inbox/ara-<YYYYMMDDTHHMMSS>-<slug>.json` to the `inbox` branch of `mogesjohnson/post-it-board`, and the
workflow pins it. Instructions she can follow: **[docs/ara-instructions.md](docs/ara-instructions.md)**.

If it works, this costs nothing extra and keeps all of the car's Grok features (navigation, car controls). On its
own, its weakness is that **if you forget to say "post it", nothing is saved**. Path 1 covers that. The automation
skips the parts of a conversation Ara already posted, so you don't get two pages
([details](docs/transcript-automation.md#6-idempotency-and-dedup)).

### Optional alternative (legacy): custom Android voice app (superseded)

> **Superseded.** Kept only as a fallback in case the transcript can't be read reliably.

The earlier design was a native Android app (Kotlin + Jetpack Compose, generated with Google AI Studio) that ran
**its own Ara session** through xAI's realtime voice API, played through the car over Bluetooth, and used Ara's
"finished speaking" events to start an 8 s silence timer (tunable 5–30 s). It needed a home-screen widget, a
foreground service, Bluetooth audio routing, an xAI API key and one tap before each drive. While you used it you
lost the car's built-in Grok features (navigation, car controls).

Legacy docs (kept for reference):

- [docs/ai-studio-prompt.md](docs/ai-studio-prompt.md): the one copy-paste prompt that generates the app;
- [docs/architecture.md → Legacy path](docs/architecture.md#legacy-path-custom-android-voice-app-superseded): timer rules, sequence diagram, failure modes;
- [docs/setup-checklist.md → Legacy steps](docs/setup-checklist.md#legacy-optional-android-voice-app-superseded): xAI key, AI Studio build, install, car pairing;
- [docs/risks.md → Legacy risks](docs/risks.md#legacy-path-risks-android-voice-app-superseded).

Why it was replaced: [comparison table](docs/transcript-automation.md#how-this-replaces-the-phone-app-design).

---

## Why not Bluetooth "downlink sniffing"

The very first idea was to have a phone app watch the Bluetooth hands-free (HFP) **downlink** to notice
when the car's built-in Grok stops talking, then summarize and post. **That does not work**, for four
independent reasons:

1. **The car's Grok audio never goes through the phone.** The built-in Grok runs in the car and plays through the
   car's speakers. Its audio is never sent to the phone over Bluetooth, so there is no stream to listen to.
2. **HFP flows the other way round.** In the hands-free profile the *phone* is the audio gateway. Phone → car
   carries call audio to the car speakers, and car mic → phone carries the driver's voice. There is no
   "car assistant → phone" channel.
3. **Third-party apps can't read call audio anyway.** Capturing SCO/HFP call audio or other apps' output requires
   `CAPTURE_AUDIO_OUTPUT`, a signature/privileged permission that is only granted to system apps.
4. **Bluetooth carries no text.** Even perfect audio timing would give nothing to summarize.

**No Tesla or Grok event hooks exist either.** Tesla's
[Fleet Telemetry available data](https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data) covers
vehicle signals (charging, climate, driving, location, media, safety…), with no voice-assistant or session events.
xAI's [Grok Automations](https://x.ai/news/grok-automations) run **on a schedule or when an email arrives**,
not on in-car voice events or session end.

**Phone-mic recording is rejected too.** Recording the cabin with the phone's microphone would capture passengers and
the radio. It also runs into **two-party (all-party) consent** laws in states such as **Maryland and California**,
where recording a private conversation needs everyone's consent. Not worth the legal or privacy risk.

**What works instead:** the conversation is already saved as a **text transcript in your Grok account** (that's
why it shows up in the phone's Grok app). Reading that transcript after the fact (path 1) gives both the timing
and the text, with no audio capture at all. The legacy app solved the same problem by *being* the voice assistant.

## Secrets model

| Path | Holds | Never holds |
|---|---|---|
| Inbox workflow (post-it-board Actions) | Encrypted repo secrets for the Supabase bot sign-in | — |
| 1. Transcript automation | A **fine-grained GitHub PAT**: only `mogesjohnson/post-it-board`, **Contents: read and write**, ≤ 90-day expiry. Plus whatever the transcript reader needs (e.g. a signed-in Grok session for browser automation, which is sensitive) | Supabase credentials, `service_role` key |
| 2. Ara "post it" | Her own GitHub tool access (unverified, see [risks](docs/risks.md)) | Supabase credentials |
| Legacy Android app | GitHub PAT + xAI key in Keystore-backed storage on the phone ([details](docs/architecture.md#secrets-model-legacy-app)) | Supabase credentials |

If the GitHub token leaks, someone can push files to post-it-board: post or delete notes via the inbox, change the site
on `main`, or change `main`'s `scripts/post.mjs`, which the inbox workflow runs with the Supabase bot secrets, to steal
the bot password. **Protect `main` with a branch ruleset** that blocks direct pushes
([setup-checklist.md](docs/setup-checklist.md) step 2). Revoke a leaked token in one click and revert with git. Store
tokens in the runner's secret store, never in any repo.

## Status

| Item | Status |
|------|--------|
| Board, Supabase, inbox workflow | ✅ live (post-it-board) |
| 1. Transcript automation | 📄 designed ([transcript-automation](docs/transcript-automation.md)). **Transcript-reading method unverified**, not built yet |
| 2. Ara pushes to inbox on "post it" | 📄 instructions written ([ara-instructions](docs/ara-instructions.md)). **Untested:** Ara's GitHub access is unverified |
| Legacy Android voice app | 🗄️ superseded. Spec + generation prompt kept ([ai-studio-prompt](docs/ai-studio-prompt.md)), not built |

## License

[MIT](LICENSE)
