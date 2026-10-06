# How to post it 🚗 ➜ 📌

**How dictated car notes reach the [Post-it Board](https://mogesjohnson.github.io/post-it-board/):**
the voice app spec, the AI Studio prompt, and the architecture.

This is a **documentation and spec repo**. It has no app code yet and no secrets. The app is generated
from [`docs/ai-studio-prompt.md`](docs/ai-studio-prompt.md).

| Doc | What's in it |
|-----|--------------|
| [docs/architecture.md](docs/architecture.md) | Diagrams of both write paths, who does what, the safety-net timer, failure modes |
| [docs/ai-studio-prompt.md](docs/ai-studio-prompt.md) | One copy-paste prompt that generates the Android app |
| [docs/ara-instructions.md](docs/ara-instructions.md) | What the built-in car Grok ("Ara") does when you say "post it" |
| [docs/setup-checklist.md](docs/setup-checklist.md) | The steps you do by hand |
| [docs/risks.md](docs/risks.md) | Honest risks and the list of unverified assumptions |
| [templates/](templates/) | Example command files (add / edit / delete) |
| [scripts/send-test-command.sh](scripts/send-test-command.sh) | Pushes a test command into the board's inbox with `gh` |

---

## Goal

Dictate notes while driving a Tesla and have them land on the board with **zero friction**:

- say **"post it"** and the note is pinned (one pin per topic, one page per note);
- **safety net:** if the conversation ends *without* "post it", the session is still summarized and
  pinned automatically, so nothing is lost.

No screens, no typing, no taps while driving.

## The existing board (already live)

Repo: **[mogesjohnson/post-it-board](https://github.com/mogesjohnson/post-it-board)**. Site: **https://mogesjohnson.github.io/post-it-board/**

- **Site:** static HTML/CSS/vanilla JS on GitHub Pages (from `main` / root). It looks like a classroom
  corkboard: days → pins (topics) → pages (notes).
- **Data:** Supabase (free plan). The tables are `days`, `pins`, `pages` and `board_owners`, all with Row Level Security:
  - the **anon key** in the site's `config.js` is public by design and can only **read**;
  - **writes** are allowed only for signed-in users listed in `public.board_owners`, which today means the human owner and a
    **bot account** used by automation;
  - deleting a pin removes its pages too (cascade).
- **Writer:** `scripts/post.mjs` (Node 18+). It does quick-add from the command line and also runs JSON command files.
- **Inbox:** a GitHub Actions workflow on the **`inbox` branch**. Anything that can push a JSON file to
  `inbox/<name>.json` can add, edit or delete notes. The workflow signs in as the bot, applies the command,
  writes `inbox/results/<name>.json`, removes the command file and pushes the result back.
  Full format: **[post-it-board inbox/README.md (inbox branch)](https://github.com/mogesjohnson/post-it-board/blob/inbox/inbox/README.md)**.

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

**add** matches the topic loosely (case, spaces, punctuation and small typos are ignored), so "AI" and "ai!"
land on the same pin. **edit/delete** never guess.

## Why the board repo stays public

- **Actions secrets are encrypted.** They are never shown in logs (GitHub masks them) and are only
  available to workflows in this repo.
- **Forks can't get the secrets.** Workflows triggered by pull requests from forks don't receive repository secrets, and the
  inbox workflow only runs on pushes to `inbox`, which needs write access.
- **The anon key is public by design.** It's in the site's JavaScript anyway, and RLS makes it read-only.
- **GitHub Pages on a private repo needs a paid plan.** Keeping the repo public keeps the board free.
- **The notes are public anyway.** Command and result files are readable in the repo, but they only contain note text,
  which the board shows publicly.

## Two write paths

### A: Ara in the car says "post it" (built-in Grok)

The car's built-in Grok ("Ara") has GitHub tools. When you say **"post it"**, she writes
`inbox/ara-<YYYYMMDDTHHMMSS>-<slug>.json` to the `inbox` branch of `mogesjohnson/post-it-board`, and the
workflow pins it. Instructions she can follow: **[docs/ara-instructions.md](docs/ara-instructions.md)**.

This path costs nothing extra and keeps all of the car's Grok features (navigation, car controls). Its only weakness:
**if you forget to say "post it", nothing is saved.**

### B: Safety net, a custom Android voice app

A native Android app (Kotlin + Jetpack Compose) runs **its own Ara session** through xAI's realtime voice
API and plays it through the car over Bluetooth. Because the app *is* the conversation, it knows exactly
when each side speaks and has the full transcript. When the conversation goes quiet it summarizes and
pins it, whether or not you said "post it". Details below and in
**[docs/architecture.md](docs/architecture.md)**.

> **Trade-off:** while you use the custom app, you are *not* using the car's built-in Grok, so that session has no
> car controls or navigation through Grok. Path A still works whenever you talk to the built-in Grok and say "post it".

---

## Why not Bluetooth "downlink sniffing"

The original idea was to have a phone app watch the Bluetooth hands-free (HFP) **downlink** to notice
when the car's built-in Grok stops talking, then summarize and post. **That does not work**, for four
independent reasons:

1. **The car's Grok never goes through the phone.** The built-in Grok runs in the car and plays through the car's
   speakers. Its audio is never sent to the phone over Bluetooth, so there is no stream to listen to.
2. **HFP flows the other way round.** In the hands-free profile the *phone* is the audio gateway. Phone → car
   carries call audio to the car speakers, and car mic → phone carries the driver's voice. There is no
   "car assistant → phone" channel.
3. **Third-party apps can't read call audio anyway.** Capturing SCO/HFP call audio or other apps' output requires
   `CAPTURE_AUDIO_OUTPUT`, a signature/privileged permission that is only granted to system apps.
4. **Even perfect timing would be useless.** The built-in Grok exposes **no transcript** to the phone, so there would be
   nothing to summarize.

**No Tesla or Grok hooks exist either.** Tesla's
[Fleet Telemetry available data](https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data) covers
vehicle signals (charging, climate, driving, location, media, safety…), with no voice-assistant or session events.
xAI's [Grok Automations](https://x.ai/news/grok-automations) run **on a schedule or when an email arrives**,
not on in-car voice events or session end.

**Phone-mic recording is rejected too.** Recording the cabin with the phone's microphone would capture passengers and
the radio. It also runs into **two-party (all-party) consent** laws in states such as **Maryland and California**,
where recording a private conversation needs everyone's consent. Not worth the legal or privacy risk.

**The fix: own the conversation.** If the app *is* the voice assistant, it legitimately has the timing and the
transcript. That's path B.

---

## The working design (path B)

**App:** native Android, Kotlin + Jetpack Compose.

**Voice:** the app opens its own session with xAI's realtime voice API, **`wss://api.x.ai/v1/realtime`**, voice **`ara`**
([docs](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech)), with server VAD turn detection.
Audio goes through the car over Bluetooth (phone call/communication audio routing, so the car's mic and speakers are
used).

**What the API tells the app:**

| Event | Meaning for the app |
|-------|---------------------|
| `input_audio_buffer.speech_started` | you started talking → **cancel the timer** |
| `input_audio_buffer.speech_stopped` | you stopped talking |
| `response.output_audio.done` / `response.done` | Ara finished her turn → **start the timer** (if nothing else is pending) |
| input/output transcript events | both sides as text → the transcript to summarize |

**Safety-net timer**

- It starts only after Ara finishes speaking (`response.done`) **and** no response is pending (no tool call in progress, no
  queued `response.create`).
- It resets whenever you start speaking.
- **Default: 8 seconds** (your starting guess). It can be set from **5 to 30 s** in settings.
- Research suggests the built-in car Grok closes after **~15 s** of inactivity. That comes from secondary sources and is
  **unverified**. Ara can also pause while thinking, which is why the timer waits for `response.done`, not
  just silence.

**When the timer fires**

1. Summarize the session transcript with the xAI text API (Gemini is an alternative), and derive a short pin topic.
2. Push `inbox/<session-id>.json` with `op: add` to `mogesjohnson/post-it-board` on branch `inbox` via the GitHub
   contents API (`PUT /repos/{owner}/{repo}/contents/{path}` with `branch: inbox`).
3. If the same session fires again (you kept talking), update the **same path** with its current `sha`, so the newer
   summary replaces the older command.

**Replace vs. duplicate:** `post.mjs` already skips *identical* text added to the same pin within 10 minutes. But a
*longer* second summary is different text, so today it would be added as a second page. True **replace**
semantics need the session id:

> **Proposed follow-up in post-it-board (not implemented yet):** add an optional `"sessionId"` field. When an
> `add` arrives with a sessionId that already created a page, `post.mjs` edits that page instead of adding a new
> one. Until then, `sessionId` is ignored.

**"Post it" inside the app** pushes immediately and doesn't wait for the timer.

**Runs in the car without touching the phone**

- **Foreground service:** type `microphone` + `connectedDevice` (+ `mediaPlayback` if output goes over A2DP), with a
  persistent notification.
- **Auto-arm on car connect:**
  - **CompanionDeviceManager** is the sanctioned way to react when the car's Bluetooth device appears.
  - A receiver for `BluetoothDevice.ACTION_ACL_CONNECTED` is a fallback. It needs `BLUETOOTH_CONNECT` on Android 12+.
- **One-tap honesty:** Android 14+ won't let a backgrounded app *start* a **microphone** foreground service, even with the
  companion exemption, because `RECORD_AUDIO` is a while-in-use permission. So the app **arms itself** when the car
  connects (notification + widget ready). The microphone session starts with **one tap** on the notification or widget,
  or when the app is already open. Tap before you pull out. See [docs/risks.md](docs/risks.md).
- **Home-screen widget (Glance):** status, countdown, **Force post**, **Cancel**.
- **Log screen:** what was posted and each inbox result status, read by polling `inbox/results/<session-id>.json`.

## Secrets model (honest)

Android apps have **no truly safe place for long-lived secrets** in client code. Anything shipped in the APK can be
extracted. The options:

**(a) Recommended for personal use: keys you enter once, kept on the device.**
- **GitHub token:** a **fine-grained GitHub PAT** limited to **only `mogesjohnson/post-it-board`**, permission
  **Contents: read and write**, nothing else.
- **xAI API key.**
- **Storage:** both are typed into the app's Settings once and stored in **Android Keystore-backed
  EncryptedSharedPreferences**. They are **never** in source code or any repo.
- **Blast radius:** if the PAT leaks, someone can push files to post-it-board (and so post or delete notes through the
  inbox). Nothing else on your account is reachable. Revoke it on GitHub in one click.
- **xAI realtime auth:** xAI documents **ephemeral client secrets** (`POST https://api.x.ai/v1/realtime/client_secrets`)
  for mobile and browser clients, and recommends them over putting the API key on the client. Minting one needs the real
  API key, so in option (a) the app would mint its own tokens and the key still lives on the phone. True separation
  needs option (b). *(Verify the details in xAI's docs before building.)*

**(b) A tiny proxy holding the keys** (e.g. a Cloudflare Worker on the free tier).
- The phone calls the proxy. The proxy mints xAI ephemeral tokens and does the GitHub push.
- Keys never touch the phone. The cost is one more thing to deploy and protect (the proxy itself needs auth).

**About Google AI Studio:** the "AI Studio auto-configures a server-side `GEMINI_API_KEY` secret" behaviour applies to
**AI Studio web apps**. Whether AI Studio's **Android build mode** offers server-side secrets is **UNVERIFIED**, so don't
count on it. Also, **AI Studio's emulator can't test Bluetooth or car audio routing**. Test on a real phone via `adb`.

## Status

| Item | Status |
|------|--------|
| Board, Supabase, inbox workflow | ✅ live (post-it-board) |
| Path A (Ara pushes to inbox) | 📄 instructions written ([ara-instructions](docs/ara-instructions.md)) |
| Path B (Android safety-net app) | 📄 spec + generation prompt ([ai-studio-prompt](docs/ai-studio-prompt.md)), app not built yet |
| `sessionId` replace semantics in `post.mjs` | 🔜 proposed follow-up, not implemented |

## License

[MIT](LICENSE)
