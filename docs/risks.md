# Risks and open questions

An honest list. Each item has a mitigation, or is marked as accepted. The first sections cover the **primary path**
([transcript automation](transcript-automation.md) + Ara's "post it"). The old Android app's risks are kept at the
end as **legacy**.

## Primary path risks (transcript automation + Ara "post it")

| Risk | Impact | Mitigation |
|---|---|---|
| **No known way to read the Grok transcript** | The whole automatic path depends on reading your Grok conversation history, and we know of no public xAI/Grok API for consumer history. | Treated as **unverified**. Evaluate the options in [transcript-automation.md §2](transcript-automation.md#2-reading-the-transcript-unverified-choose-one). Ara's "post it" doesn't need a reader, but it is untested too (unverified item 6). Keep the reader behind one adapter so it can be swapped. |
| **Browser automation is fragile** (option C) | grok.com layout changes, bot detection, session expiry or 2FA stop the reader without warning. | Alert on every read failure and on missing heartbeats. Conversations stay in history, so a fixed reader catches up within `lookbackHours`. Add a daily catch-up sweep. |
| **Signed-in Grok session = full account access** (option C) | Whoever gets the stored session can read **all** your Grok conversations, not just car ones, and act as you on grok.com. | Run the reader only on a machine you control, with disk encryption. Never put the session in a repo or a public workflow. Sign out other sessions if it leaks. Check xAI's terms of service before relying on it. |
| **Coarse timing** | With GitHub Actions cron (5-minute minimum, runs may start late) or a once-a-day Grok Automation, notes appear minutes to hours after you stop, not 8 s later. | Documented: the threshold is a minimum quiet time, checked at each poll. Use an always-on runner if latency matters. Say "post it" when you want it now. |
| **Coarse or skewed timestamps** | Minute-level or relative timestamps can't measure 8 s; a skewed clock posts too early or too late. | NTP on the runner, UTC everywhere, America/New_York for local-only times, and the "first seen" observation method when timestamps are coarse or in the future ([§3.3](transcript-automation.md#33-timestamps-clocks-and-time-zones)). |
| **Premature post** | A pause while you think, or Ara still talking (if timestamps mark a message's start), looks like silence, so a half-finished conversation is posted. | Longer wait when the newest message is yours. Tune the threshold after real drives. A later continuation sends an `edit` with the full summary, so nothing is lost. |
| **Duplicate summaries** | Ara's "post it" plus the automation, lost state, or two runners at once put two pages on the board for one conversation. | Deterministic file names + *push if absent*, `edit` for continuations, state rebuildable from `inbox/results/`, a single-runner lock, and skipping what Ara already posted ([§6](transcript-automation.md#6-idempotency-and-dedup)). `skipped_duplicate` is a backstop only. |
| **Missed posts** | Runner asleep or down longer than the lookback window, or you delete the conversation from Grok before it's read. | Heartbeat alert, longer lookback on startup, daily catch-up. Accepted for deleted conversations. |
| **Posting things that aren't car notes** | Phone/web Grok chats, or private parts of a drive, land on the **public** board. | `looks_like_car_conversation()` filter, opt-out phrase ("don't post this"), summary rules that drop personal details. Delete by hand on the board if needed, but the text stays in the repo's history (see **Note text stays in public git history**). |
| **GitHub token leakage** | Someone with the token can push to post-it-board: post or delete notes via the inbox, change the site on `main`, or change `main`'s `scripts/post.mjs` (which the inbox workflow runs with the Supabase bot secrets) to steal the bot password. | Fine-grained PAT, **post-it-board only, Contents read/write**, ≤ 90-day expiry, kept in the runner's secret store. **A branch ruleset on `main` that blocks direct pushes, with an admin bypass for pull requests only** ([setup-checklist.md](setup-checklist.md) step 2); recommended, not optional. Revoke and revert with git. |
| **Auth expiry** | Grok session or GitHub token expires; posting silently stops. | Alerts on 401/403 and read failures; calendar reminder before the token expires. Unposted state is kept until it works again. |
| **Action failures** | Bot password rotated without updating the secret, Supabase outage, etc. Results show `error`. | The workflow keeps the command file on `error`. Fix the cause, re-run the workflow (`workflow_dispatch`). The automation alerts when a result is `error` or missing after ~10 min. |
| **Transcript privacy** | Conversations already live in your Grok account; summaries go to a model (if you use one outside Grok) and to a **public** board. | Tell passengers. Summary rules leave personal details out. Opt-out phrase. Keep local state minimal (IDs, timestamps), and hash conversation IDs in public file names. |
| **Note text stays in public git history** | Every inbox command and result file holds the full note text in the **public** post-it-board repo (`inbox` branch). Deleting a note from the board doesn't remove it from there. | Keep summaries non-sensitive (summary rules, opt-out phrase). Real removal needs a history rewrite of the `inbox` branch and a force-push, and copies may already be cached or cloned. |
| **Supabase owner password exposed earlier** | It appeared in tool logs while the board was built. | Change it **first** ([setup-checklist.md](setup-checklist.md) step 1). The automation never needs it. |
| **Driver distraction** | Any screen interaction while driving is dangerous. | Nothing to tap: posting is automatic or by voice ("post it"). Review the board after the drive. |

## Unverified items: primary path (check before relying on them)

1. **Reading consumer Grok conversation history.** No public xAI/Grok API is known. The account data download
   (grok.com → Settings → Data Controls) is a manual ZIP snapshot. Whether a Grok Automation can read your other
   conversations, or push files to GitHub, is unverified. Browser automation of grok.com is possible in principle
   but unsupported.
2. **Car conversations always appear in the phone's Grok history,** and how fast. Based on what you've seen in your own
   app, not on Tesla or xAI documentation.
3. **Timestamp resolution and meaning** (seconds vs. minutes; start vs. end of a message) in whatever the reader sees.
4. **A marker that identifies car conversations.** May not exist; then filtering falls back to time windows.
5. **Grok-side rate limits and terms** for automated reading.
6. **Ara can create files in GitHub.** Ara's "post it" path assumes the in-car Grok has a tool that can create a file
   in a GitHub repo. That's unverified, and the path is untested: no `ara-…` result has appeared in the inbox yet.
   Try it on a test drive ([setup-checklist.md](setup-checklist.md) step 6) before relying on it.

---

## Legacy path risks (Android voice app, superseded)

> **Superseded, optional legacy.** These apply only if you build the old app from [ai-studio-prompt.md](ai-studio-prompt.md).

| Risk | Impact | Mitigation |
|---|---|---|
| **xAI voice API cost** | Realtime voice is billed per minute of audio, and a long drive with the session open costs money every minute. | Check current pricing on xAI's site; this repo deliberately quotes no numbers. Set a spending limit or alert in the xAI console. The app ends the session (and stops billing) after the safety-net post plus an idle grace period, and has a visible Stop button. Max session is 120 min. |
| **Summarization cost** | One text call per session (xAI or Gemini). | Small. Cap transcript length and use a cheap/fast model. |
| **Battery drain** | Mic capture, a WebSocket and audio playback for a whole drive. | Phone is usually charging in the car. Stop the session when the car disconnects. No wake locks after the session ends. |
| **Android background limits** | On Android 14+, a microphone foreground service can't start from the background, even with the CompanionDeviceManager exemption. | The app auto-**arms** on car connect (connectedDevice FGS + notification/widget). The mic session needs **one tap**. This is accepted and documented. |
| **OEM battery killers** (Samsung, Xiaomi, OnePlus, …) | The service gets killed mid-drive, so the safety net never fires. | Ask for the "Unrestricted" battery setting during onboarding (https://dontkillmyapp.com). Persist the transcript to disk as it arrives. On restart, push any unposted session. |
| **Network dead zones** | WebSocket drops; the push fails. | Queue pushes in a local DB (Room) and retry with backoff (e.g. WorkManager with a network constraint). Reconnect the voice session, using session resumption if available. The transcript stays local until a push succeeds. |
| **Driver distraction** | Any screen interaction while driving is dangerous. | Voice-only during the drive: "post it" by voice, auto-post by timer. The widget and notification are for before or after driving. No reading required: Ara confirms by voice. |
| **Duplicate summaries (app)** | The timer fires, the user talks again, the timer fires again, so the board gets two pages for one drive. | The app re-PUTs the same `inbox/<session-id>.json` with its `sha`. But the inbox workflow deletes processed files, so the second push may be a new file that gets processed as a new add. post.mjs only dedups *identical* text. Real fix: the `sessionId` follow-up in post-it-board (replace the page created by that session). Until then, accept occasional duplicates or delete them by hand. |
| **Transcript privacy** | Drive conversations go to xAI (and Gemini, if used for summaries) and the summary lands on a **public** board. | Tell passengers. Ara's system prompt says to leave personal or sensitive details out of summaries. A "Don't post this session" voice command and a Cancel button. Local transcripts are auto-deleted after N days. |
| **PAT leakage** | Someone extracts the token from a rooted, lost, or compromised phone. | Fine-grained PAT, **post-it-board only, Contents read/write**, short expiry. Blast radius: they could push files to post-it-board (deface the board via the inbox, or edit the site code on `main`). Revoke the token, then revert with git. Option (b), a proxy, removes the PAT from the phone entirely. |
| **xAI key leakage** | Someone runs up API charges. | Keystore-backed storage, spending limit, rotate on loss. Ephemeral client secrets for the WebSocket where possible. Option (b), a proxy, keeps the key off the phone. |
| **Two-party consent** | Recording people without consent is illegal in some states (e.g. California, Maryland). | The app isn't a covert recorder. It's an explicit voice-assistant session the driver starts. Still: tell passengers when a session is on. |
| **No car controls in the app's session** | While using the custom app, the built-in Grok isn't in the loop, so no navigation or climate by voice through Ara. | Accepted trade-off at the time. One of the reasons the app was superseded. |
| **Tesla treats the app's audio as a call or as media** | Audio could duck the music, show a call screen, or not play at all. | Make the route configurable (media stream vs. communication/SCO) and test both in the car. |

### Unverified items: legacy app

1. **AI Studio Android build mode + server-side secrets.** The auto-configured server-side `GEMINI_API_KEY` is a
   feature of AI Studio *web* apps. Whether Android build mode has anything similar is unverified, so don't rely on it.
2. **Built-in car Grok idle timeout of ~15 s.** This comes from secondary sources, not Tesla docs. It only motivates
   the default threshold.
3. **Exact transcript event names in the xAI realtime API** (e.g. input/output transcript deltas). The VAD and
   response events are documented. Confirm the transcription event names and the session config field for input
   transcription in https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech before coding against them.
4. **Ephemeral client secrets.** xAI documents `POST /v1/realtime/client_secrets`. Verify the WebSocket auth header
   or subprotocol to use with them from a native (non-browser) client.
5. **Audio format.** Assumed PCM16 mono (24 kHz is typical for realtime APIs). Confirm the supported sample rates in
   the docs, and whether 16 kHz is accepted.
6. **`EncryptedSharedPreferences`** (androidx.security:security-crypto) is deprecated in recent releases. It still
   works, but the long-term alternative is the Android Keystore + DataStore with Tink. The prompt allows either.
7. **CompanionDeviceManager APIs.** `startObservingDevicePresence(String)` (API 31–35) vs.
   `ObservingDevicePresenceRequest` (API 36+). The generated code should handle both.
8. **How the Tesla presents the app's audio** (media vs. call UI) needs testing in the car.
9. **post-it-board `sessionId` replace semantics** is a proposal, **not implemented**.
