# Risks and open questions

An honest list. Each item has a mitigation, or is marked as accepted.

| Risk | Impact | Mitigation |
|---|---|---|
| **xAI voice API cost** | Realtime voice is billed per minute of audio, and a long drive with the session open costs money every minute. | Check current pricing on xAI's site; this repo deliberately quotes no numbers. Set a spending limit or alert in the xAI console. The app ends the session (and stops billing) after the safety-net post plus an idle grace period, and has a visible Stop button. Max session is 120 min. |
| **Summarization cost** | One text call per session (xAI or Gemini). | Small. Cap transcript length and use a cheap/fast model. |
| **Battery drain** | Mic capture, a WebSocket and audio playback for a whole drive. | Phone is usually charging in the car. Stop the session when the car disconnects. No wake locks after the session ends. |
| **Android background limits** | On Android 14+, a microphone foreground service can't start from the background, even with the CompanionDeviceManager exemption. | The app auto-**arms** on car connect (connectedDevice FGS + notification/widget). The mic session needs **one tap**. This is accepted and documented. |
| **OEM battery killers** (Samsung, Xiaomi, OnePlus, …) | The service gets killed mid-drive, so the safety net never fires. | Ask for the "Unrestricted" battery setting during onboarding (https://dontkillmyapp.com). Persist the transcript to disk as it arrives. On restart, push any unposted session. |
| **Network dead zones** | WebSocket drops; the push fails. | Queue pushes in a local DB (Room) and retry with backoff (e.g. WorkManager with a network constraint). Reconnect the voice session, using session resumption if available. The transcript stays local until a push succeeds. |
| **Driver distraction** | Any screen interaction while driving is dangerous. | Voice-only during the drive: "post it" by voice, auto-post by timer. The widget and notification are for before or after driving. No reading required: Ara confirms by voice. |
| **Duplicate summaries** | The timer fires, the user talks again, the timer fires again, so the board gets two pages for one drive. | The app re-PUTs the same `inbox/<session-id>.json` with its `sha`. But the inbox workflow deletes processed files, so the second push may be a new file that gets processed as a new add. post.mjs only dedups *identical* text. Real fix: the `sessionId` follow-up in post-it-board (replace the page created by that session). Until then, accept occasional duplicates or delete them by hand. |
| **Transcript privacy** | Drive conversations go to xAI (and Gemini, if used for summaries) and the summary lands on a **public** board. | Tell passengers. Ara's system prompt says to leave personal or sensitive details out of summaries. A "Don't post this session" voice command and a Cancel button. Local transcripts are auto-deleted after N days. |
| **PAT leakage** | Someone extracts the token from a rooted, lost, or compromised phone. | Fine-grained PAT, **post-it-board only, Contents read/write**, short expiry. Blast radius: they could push files to post-it-board (deface the board via the inbox, or edit the site code on `main`). Revoke the token, then revert with git. Option (b), a proxy, removes the PAT from the phone entirely. |
| **xAI key leakage** | Someone runs up API charges. | Keystore-backed storage, spending limit, rotate on loss. Ephemeral client secrets for the WebSocket where possible. Option (b), a proxy, keeps the key off the phone. |
| **Two-party consent** | Recording people without consent is illegal in some states (e.g. California, Maryland). | The app isn't a covert recorder. It's an explicit voice-assistant session the driver starts. Still: tell passengers when a session is on. |
| **No car controls in the app's session** | While using the custom app, the built-in Grok isn't in the loop, so no navigation or climate by voice through Ara. | Accepted trade-off. Path A (built-in Grok + "post it") still works whenever you use her. |
| **Tesla treats the app's audio as a call or as media** | Audio could duck the music, show a call screen, or not play at all. | Make the route configurable (media stream vs. communication/SCO) and test both in the car. |

## Unverified items (check before relying on them)

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
