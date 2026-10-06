> **⚠️ Superseded — optional legacy path**
>
> This prompt builds the **old** design: a custom Android voice app running its own Ara session through xAI's
> realtime voice API. It has been **superseded** by the [transcript automation](transcript-automation.md), which
> needs no phone app, no widget, no foreground service and no xAI API key. Ara's "post it"
> ([ara-instructions.md](ara-instructions.md)) remains the second way to post.
>
> Use this prompt only if the Grok transcript turns out to be unreadable and you want exact, real-time silence
> detection anyway. See the [comparison](transcript-automation.md#how-this-replaces-the-phone-app-design) and the
> [legacy setup steps](setup-checklist.md#legacy-optional-android-voice-app-superseded).

# Google AI Studio prompt (Build mode, Android)

Copy everything inside the fenced block below into **Google AI Studio → Build** (Android). The same prompt also
works with Gemini in Android Studio or any code-generating assistant.

Notes before you paste:

- **No secrets in the prompt.** The app asks for keys at runtime in its Settings screen.
- Whether AI Studio's Android build mode provides **server-side secrets** (as AI Studio web apps do with
  `GEMINI_API_KEY`) is **unverified**. This prompt doesn't rely on it.
- AI Studio's emulator **cannot test Bluetooth or car audio routing**. Install on a real phone with `adb` (see
  [setup-checklist.md](setup-checklist.md)).
- Items marked *(verify)* depend on third-party docs that may change. Check them while reviewing the generated code.

````text
Build a native Android app called "Post-it Drive" (package com.mogesjohnson.postitdrive).

PURPOSE
While I drive my Tesla, this app runs a hands-free voice conversation with "Ara" (xAI's realtime voice API,
voice "ara") through the car's Bluetooth audio. When the conversation goes quiet for a configurable number of
seconds (default 8), or when I say "post it", the app summarizes the conversation and pushes a JSON command file to
the GitHub repo mogesjohnson/post-it-board (branch "inbox", folder "inbox/"). A GitHub Actions workflow there pins
the note on my public corkboard website. The app must never require looking at or touching the screen while
driving.

TECH STACK
- Kotlin, Jetpack Compose (Material 3, dark theme by default, large touch targets), single-activity, MVVM,
  Kotlin coroutines + Flow, Hilt (or manual DI if simpler).
- minSdk 31 (Android 12), targetSdk = latest stable.
- Networking: OkHttp (WebSocket + HTTP), kotlinx.serialization for JSON.
- Persistence: Room (sessions, transcript turns, push queue, log), DataStore (non-secret settings).
- Secrets: EncryptedSharedPreferences backed by the Android Keystore (androidx.security:security-crypto). If that
  library is deprecated in the current toolchain, use DataStore + Tink AEAD with an Android Keystore master key
  instead. Never store secrets in plain SharedPreferences, files, logs, BuildConfig, resources or source code.
- Background: a foreground Service for the live session, WorkManager for retrying queued pushes.
- Widget: Jetpack Glance app widget.

HARD RULES
1. NO HARDCODED SECRETS. No API keys, tokens, passwords or example keys anywhere in code, resources, gradle files,
   tests or README. All secrets are typed by the user in Settings and stored only in the encrypted store.
2. Never log secrets, Authorization headers, or full request bodies that contain them. Redact them in any debug logging.
3. Voice-first while driving: every action during a session is available by voice. Screen UI is for setup and review.
4. Every network call has timeouts, and failures never lose data. Pushes go through a persistent queue.

SETTINGS SCREEN (all editable, validated, with "Test" buttons)
- GitHub fine-grained personal access token (secret). Hint text: "Fine-grained PAT, only repository
  mogesjohnson/post-it-board, permission Contents: Read and write." Button "Test GitHub" does
  GET https://api.github.com/repos/{owner}/{repo} and shows OK or the error.
- Repo owner (default "mogesjohnson"), repo name (default "post-it-board"), branch (default "inbox"),
  folder (default "inbox").
- xAI API key (secret). Button "Test xAI" mints an ephemeral token (see below) and shows OK or the error.
- Optional "Token proxy URL". If set, the app gets ephemeral tokens and does summaries through this URL instead of
  using the xAI key directly (for a future Cloudflare Worker). Leave the request format as a simple documented
  JSON contract in the README.
- Voice (default "ara"), realtime model (default "grok-voice-latest"), summary model (text field; default empty
  and REQUIRED before first use; helper text "Pick a current Grok text model from docs.x.ai" — do not hardcode a
  model name you are unsure of; optionally fetch GET https://api.x.ai/v1/models to offer a dropdown).
- Safety-net threshold slider: 5–30 seconds, default 8, step 1. Show "Starts after Ara finishes speaking".
- "Post it" trigger phrases (default: "post it", "pin it", "post that").
- Car device: button "Pair car for auto-arm" that runs the CompanionDeviceManager association flow (see AUTO-ARM).
- Toggle "Auto-arm when car connects" (default on).
- Button "Clear all secrets".

REALTIME VOICE SESSION (xAI)
- Auth: before connecting, mint an EPHEMERAL client secret:
  POST https://api.x.ai/v1/realtime/client_secrets
  Headers: Authorization: Bearer <xAI API key from encrypted store>, Content-Type: application/json
  Body: {"expires_after":{"seconds":600}}
  Response contains "value" (token) and "expires_at". Connect the WebSocket with header
  "Authorization: Bearer <value>". (verify field names in docs.x.ai). If a proxy URL is set, get the token from the
  proxy instead.
- WebSocket: wss://api.x.ai/v1/realtime?model=<realtime model> using OkHttp.
- After open, send session.update:
  {
    "type": "session.update",
    "session": {
      "voice": "<voice, default ara>",
      "instructions": "<SYSTEM PROMPT below>",
      "turn_detection": {"type": "server_vad"},
      "audio": {
        "input":  {"format": {"type": "audio/pcm", "rate": 16000}},
        "output": {"format": {"type": "audio/pcm", "rate": 16000}}
      },
      "resumption": {"enabled": true},
      "tools": [{
        "type": "function",
        "name": "post_it",
        "description": "Call when the driver asks to post, pin or save the conversation to the Post-it Board.",
        "parameters": {"type": "object", "properties": {
          "topic": {"type": "string", "description": "Short pin topic, 1-4 words"}
        }}
      }]
    }
  }
  Enable input transcription if the API requires it (docs mention audio.input.transcription.model
  "grok-transcribe") (verify).
- 16 kHz PCM16 mono little-endian in both directions (matches Bluetooth wideband HFP and avoids resampling).
  If the server rejects 16000, fall back to 24000 and resample.
- Mic capture: AudioRecord with VOICE_COMMUNICATION source, 16 kHz mono PCM16, ~100 ms chunks, enable
  AcousticEchoCanceler and NoiseSuppressor when available. Send each chunk as
  {"type":"input_audio_buffer.append","audio":"<base64>"}.
- Playback: AudioTrack (USAGE_VOICE_COMMUNICATION, CONTENT_TYPE_SPEECH), stream every
  response.output_audio.delta immediately (base64 PCM16). Track when local playback has drained.
- Bluetooth routing: set AudioManager mode to MODE_IN_COMMUNICATION and on Android 12+ call
  setCommunicationDevice() with the connected Bluetooth SCO/headset device (fallback: startBluetoothSco on old
  APIs). This uses the car's microphone and speakers. Restore audio mode and clear the communication device on
  session end. If no Bluetooth device is present, use the phone's speaker and mic and show a warning.
- Server events to handle (log type names in a debug view):
  input_audio_buffer.speech_started, input_audio_buffer.speech_stopped, input_audio_buffer.committed,
  response.created, response.output_audio.delta, response.output_audio.done, response.done,
  response.output_audio_transcript.delta/.done (assistant text), conversation.item.input_audio_transcription.*
  (user text; xAI uses ".updated" with cumulative text) (verify names), response.function_call_arguments.done,
  conversation.created (store conversation.id for resumption), error.
- Barge-in: on speech_started while Ara is speaking, stop and flush AudioTrack immediately.
- Function call "post_it": run POST NOW (below) with the optional topic, then send
  {"type":"conversation.item.create","item":{"type":"function_call_output","call_id":"<id>","output":"{\"status\":\"queued\"}"}},
  wait until local playback drains, then send {"type":"response.create"} so Ara confirms out loud ("Posted.").
- Also detect the trigger phrases in the user transcript as a fallback (case-insensitive) in case the model doesn't
  call the tool.
- Reconnect with exponential backoff on failure. Reuse conversation_id for resumption. Keep the local transcript.
- SYSTEM PROMPT for Ara (instructions): "You are Ara, a calm, concise co-pilot talking to a driver. Keep answers
  short and spoken-friendly; never ask the driver to look at a screen. The driver dictates notes and ideas. When
  the driver says 'post it', 'pin it' or similar, call the post_it tool with a 1-4 word topic, then confirm in one
  short sentence. Do not read URLs or long lists aloud."

TRANSCRIPT
- Store every turn in Room: sessionId, role (user|assistant), text, timestamps. Update the user turn when
  cumulative transcription updates arrive. Flush to disk after every turn so a crash or kill doesn't lose it.

SAFETY-NET TIMER (exact rules — implement as a pure, unit-tested state machine with an injectable clock)
- States: IDLE, LISTENING, ARA_SPEAKING, WAITING, POSTING, POSTED.
- START the countdown only when ALL are true: a response.done was received, no response is in flight (no
  response.created without response.done, no unanswered function call, no pending response.create), and local
  playback has drained.
- RESET/CANCEL on input_audio_buffer.speech_started, on response.created, or when the user taps Cancel.
- FIRE when the countdown reaches the threshold (Settings; default 8 s; range 5–30 s) → POST NOW.
- After firing, the session continues. If talking resumes and it goes quiet again, fire again, and the new summary
  covers the WHOLE session and REPLACES the earlier command file (same path; see GITHUB PUSH).
- Expose the countdown as a StateFlow for the notification, widget and UI.
- Fire immediately (if there is unposted content) when the car's Bluetooth disconnects or the user stops the session.

POST NOW (summarize + push)
1. Build the transcript text of the whole session (skip empty turns).
2. Summarize with the xAI text API: POST https://api.x.ai/v1/chat/completions,
   Authorization: Bearer <xAI key>, model = <summary model from Settings>, temperature 0.3,
   ask for STRICT JSON only: {"topic": "1-4 word pin topic", "summary": "concise bullet-style note, max 1200 chars"}.
   If the tool call supplied a topic, prefer it. Parse defensively. On failure, use topic "Drive notes" and the last
   ~800 characters of the user's own words as the body.
3. Write the command file JSON (exact shape):
   {
     "op": "add",
     "date": "<YYYY-MM-DD of session start in America/New_York>",
     "pin": "<topic>",
     "title": "Drive summary <HH:MM local time of session start>",
     "body": "<summary>",
     "sessionId": "<session id>"
   }
   Session id format: drive-YYYYMMDD-HHMMSS-<4 random lowercase alphanumerics>. Limits enforced by the server:
   pin ≤ 200 chars, title ≤ 200, body ≤ 5000; truncate safely before sending.
   NOTE: "sessionId" is currently IGNORED by the board's script (post.mjs); a follow-up will use it to replace the
   page created earlier by the same session. Always send it anyway.
4. Enqueue a push (Room table PendingPush: sessionId, path, json, attempts, lastError, createdAt) and let a
   WorkManager job (network constraint, exponential backoff) perform GITHUB PUSH. Return immediately.

GITHUB PUSH (contents API, sha-based update)
- Path: "<folder>/<sessionId>.json" (e.g. inbox/drive-20261005-174512-k3p9.json). Branch: Settings branch ("inbox").
- Headers: Authorization: Bearer <PAT>, Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28.
- Step 1: GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}
  200 → remember "sha" (file still waiting to be processed: we will REPLACE it). 404 → no sha (new file, or the
  workflow already processed and deleted the previous one).
- Step 2: PUT https://api.github.com/repos/{owner}/{repo}/contents/{path}
  body {"message":"post-it-drive: <sessionId>","content":"<base64 of UTF-8 JSON>","branch":"<branch>",
        "sha":"<sha if any>"}
- 409/422 (stale sha): repeat step 1 once and retry. 401/403: mark queue item blocked, post a notification
  "GitHub token invalid — open Settings". Other errors / no network: retry with backoff, keep the item.
- Never use force pushes or the git data API; contents API only.

RESULT POLLING + LOG SCREEN
- After a successful PUT, poll GET contents "<folder>/results/<sessionId>.json?ref=<branch>" every 15 s for up to
  5 minutes (base64 → JSON). Show its "status" and "message" (ok, skipped_duplicate, skipped_ambiguous,
  skipped_not_found, error_invalid, error).
- Log screen (LazyColumn): one card per push — time, topic, first lines of summary, queue state (queued, pushed,
  processed), result status chip, and a link to https://mogesjohnson.github.io/post-it-board/. Tap for the full
  JSON sent and the full result.

FOREGROUND SERVICE + NOTIFICATION
- VoiceSessionService: foreground service with types microphone|connectedDevice (add mediaPlayback only if you
  play over A2DP). Declare FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, FOREGROUND_SERVICE_CONNECTED_DEVICE
  (and FOREGROUND_SERVICE_MEDIA_PLAYBACK if used).
- Persistent notification: state (Armed / Listening / Ara speaking / Posting in 6 s / Posted / Queued offline),
  actions: Start session, Force post, Cancel timer, Stop.
- IMPORTANT Android 14+ rule: a microphone foreground service cannot be STARTED from the background (RECORD_AUDIO is
  a while-in-use permission), even with the CompanionDeviceManager exemption. Therefore:
  * When the car connects, start only an "armed" foreground service of type connectedDevice (allowed via the
    companion exemption) and show the notification with a big "Start Ara" action. Also update the widget.
  * The microphone session (startForeground with type microphone) starts from a user interaction: tapping the
    notification action, the widget button, or the app UI. Handle ForegroundServiceStartNotAllowedException and
    SecurityException gracefully with a clear message.
  * Bonus (optional, investigate): a MediaSession that maps a steering-wheel media "play" button to Start session.

AUTO-ARM WHEN THE CAR CONNECTS
- Preferred: CompanionDeviceManager. Associate with the car's Bluetooth device (AssociationRequest +
  BluetoothDeviceFilter, user picks the car once). Implement a CompanionDeviceService and observe device presence
  (startObservingDevicePresence(String) on API 31–35; on API 36+ use the ObservingDevicePresenceRequest variant).
  Declare REQUEST_COMPANION_START_FOREGROUND_SERVICES_FROM_BACKGROUND and REQUEST_OBSERVE_COMPANION_DEVICE_PRESENCE
  as needed. On appear → arm; on disappear → fire safety net if needed, then stop.
- Fallback: a BroadcastReceiver registered by the running service for BluetoothDevice.ACTION_ACL_CONNECTED /
  ACTION_ACL_DISCONNECTED filtered to the chosen device address (needs BLUETOOTH_CONNECT runtime permission on 12+).

GLANCE WIDGET
- Shows: state, countdown seconds while WAITING, last post status. Buttons: Start session, Force post, Cancel.
- Updates from the same StateFlow via a GlanceAppWidget update on state changes (throttle to ~1/s).

PERMISSIONS (manifest + runtime flow with clear rationale screens)
- RECORD_AUDIO, BLUETOOTH_CONNECT, POST_NOTIFICATIONS (13+), INTERNET, ACCESS_NETWORK_STATE,
  MODIFY_AUDIO_SETTINGS, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, FOREGROUND_SERVICE_CONNECTED_DEVICE,
  (FOREGROUND_SERVICE_MEDIA_PLAYBACK if used), REQUEST_COMPANION_START_FOREGROUND_SERVICES_FROM_BACKGROUND,
  REQUEST_OBSERVE_COMPANION_DEVICE_PRESENCE (where applicable), RECEIVE_BOOT_COMPLETED (only to re-register
  presence observation; never start the mic from boot).
- Offer a one-time prompt to exclude the app from battery optimization (explain why); don't force it.

SCREENS
1. Home: big status, countdown ring, Start/Stop session, Force post, Cancel, live transcript (last few turns),
   connection indicators (Bluetooth car, xAI, GitHub queue).
2. Settings (above). 3. Log (above). 4. Onboarding checklist: permissions, keys entered + tested, car paired,
   widget added.

TESTS
- Unit tests for the safety-net state machine (fake clock): starts only after response.done with nothing pending;
  resets on speech_started; fires at threshold; re-fire replaces; threshold bounds 5–30.
- Unit tests for command JSON building (limits, date in America/New_York, session id format).
- Unit tests for GitHub push logic with MockWebServer: 404→create, 200→update with sha, 409→refetch+retry,
  401→blocked.
- No test may contain a real-looking secret.

DELIVERABLES
- Complete Gradle project that builds with the latest stable Android Gradle Plugin.
- README.md: setup (create fine-grained PAT limited to mogesjohnson/post-it-board with Contents read/write; get an
  xAI API key; enter both in Settings), how to install via adb on a real phone, pairing the car, the command file
  format above, and a "Known limitations" section (mic session needs one tap on Android 14+; emulator cannot test
  Bluetooth routing; sessionId ignored by the board until the follow-up lands).
- .gitignore that excludes local.properties, keystores, .env and build outputs.
````

## Exact command file the app writes

```json
{
  "op": "add",
  "date": "2026-10-05",
  "pin": "<topic>",
  "title": "Drive summary <HH:MM>",
  "body": "<summary>",
  "sessionId": "<id>"
}
```

- `date` is optional for the board (it defaults to today in America/New_York). The app sends the session's start date
  so that a drive crossing midnight lands on the right day.
- `sessionId` is **ignored by the current `post.mjs`** until the follow-up lands. The board's validator currently
  ignores unknown fields, so sending it is harmless today.
