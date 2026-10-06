# Architecture

Two independent write paths end in the same place: a JSON command file on the `inbox` branch of
[mogesjohnson/post-it-board](https://github.com/mogesjohnson/post-it-board), applied by GitHub Actions to
Supabase, and shown on https://mogesjohnson.github.io/post-it-board/.

## Full loop (Mermaid)

```mermaid
flowchart LR
  subgraph Car["Tesla cabin"]
    Driver(("Driver"))
    BuiltIn["Built-in Grok (Ara)<br/>runs in the car"]
    CarAudio["Car mic + speakers<br/>(Bluetooth HFP to phone)"]
  end

  subgraph Phone["Android phone"]
    App["Post-it voice app<br/>(foreground service)"]
    Store["EncryptedSharedPreferences<br/>(PAT + xAI key)"]
    Queue["Local push queue<br/>(retry offline)"]
  end

  subgraph XAI["xAI API"]
    RT["Realtime voice<br/>wss://api.x.ai/v1/realtime<br/>voice: ara, server VAD"]
    TXT["Text API<br/>(summary + topic)"]
  end

  subgraph GH["GitHub: mogesjohnson/post-it-board"]
    Inbox["inbox branch<br/>inbox/*.json"]
    Actions["inbox workflow<br/>node scripts/post.mjs --command-file"]
    Results["inbox/results/*.json"]
    Pages["GitHub Pages (main)"]
  end

  subgraph SB["Supabase (RLS)"]
    DB[("days / pins / pages<br/>board_owners")]
  end

  %% Path A
  Driver -- "talks, says 'post it'" --> BuiltIn
  BuiltIn -- "A: GitHub tool writes<br/>inbox/ara-*.json" --> Inbox

  %% Path B
  Driver <-- "voice" --> CarAudio
  CarAudio <-- "Bluetooth audio" --> App
  App <-- "PCM16 audio + events<br/>+ transcripts" --> RT
  App -- "timer fired / 'post it'" --> TXT
  Store -.-> App
  App -- "B: PUT contents API<br/>inbox/<session-id>.json" --> Queue
  Queue --> Inbox

  %% Shared
  Inbox -- "push trigger" --> Actions
  Actions -- "bot sign-in, REST writes" --> DB
  Actions --> Results
  Results -. "poll status" .-> App
  Pages -- "anon key, read-only" --> DB
```

## Full loop (ASCII)

```
 PATH A (built-in Grok)                         PATH B (custom Android app)
 ======================                         ===========================

  Driver ──"…post it"──▶ Built-in Grok           Driver ◀──voice──▶ Car mic/speakers
                         (in the car)                                   │ Bluetooth (HFP/SCO)
                              │                                         ▼
                              │ GitHub tool                    ┌──────────────────────┐
                              │                                │  Android app (FGS)    │
                              │                                │  • xAI realtime client│◀──▶ wss://api.x.ai/v1/realtime
                              │                                │  • transcript         │     (voice "ara", server VAD,
                              │                                │  • safety-net timer   │      speech/response events)
                              │                                │  • summarizer         │───▶ xAI text API (summary+topic)
                              │                                │  • push queue         │
                              │                                └──────────┬───────────┘
                              │ inbox/ara-<ts>-<slug>.json                │ PUT /repos/.../contents/inbox/<session-id>.json
                              ▼                                           ▼ (branch=inbox, sha on update)
                    ┌───────────────────────────────────────────────────────────────┐
                    │ GitHub  mogesjohnson/post-it-board  ·  branch "inbox"          │
                    │   inbox/*.json ──push──▶ Actions "inbox" workflow              │
                    │                          node scripts/post.mjs --command-file  │
                    │   inbox/results/*.json ◀── result (status, matched, message)  │
                    └───────────────────────────────┬───────────────────────────────┘
                                                    │ bot account sign-in (RLS: board_owners)
                                                    ▼
                                     ┌──────────────────────────────┐
                                     │ Supabase  days ▸ pins ▸ pages │
                                     └──────────────┬───────────────┘
                                                    │ anon key (read-only)
                                                    ▼
                              https://mogesjohnson.github.io/post-it-board/  (GitHub Pages)
```

## Who does what

| Component | Responsibility | Not responsible for |
|-----------|----------------|---------------------|
| **Ara (built-in car Grok)** | Path A: on "post it", turns the conversation into a command file and pushes it to `inbox/ara-*.json` via her GitHub tools. Can check `inbox/results/` | Anything automatic. If you don't say "post it", nothing happens. Exposes no events or transcript to the phone |
| **Android app** | Path B: runs its own Ara voice session through the car's Bluetooth audio, keeps the transcript, runs the safety-net timer, summarizes, pushes/updates `inbox/<session-id>.json`, queues offline, shows status (notification, widget, log) | Car controls or navigation (that's the built-in Grok). Holding secrets safely beyond the Keystore-backed storage |
| **xAI API** | Realtime speech-to-speech (`wss://api.x.ai/v1/realtime`, voice `ara`, server VAD events, transcripts). Text API for the summary and pin topic. Ephemeral client secrets | Storing notes |
| **GitHub inbox + Actions** | Accepts command files on `inbox`, runs `post.mjs` with repo secrets (bot account), writes `inbox/results/<name>.json`, deletes processed commands, serialized by a concurrency group | Deciding *what* to post; it only executes commands |
| **Supabase** | Source of truth (days/pins/pages). RLS: public read, writes only for `board_owners` (owner + bot) | Auth for the phone app (the app never talks to Supabase directly) |
| **Pages site** | Read-only corkboard UI with the anon key. The owner can sign in to edit or delete by hand | Accepting writes from the car |

## Safety-net timer (path B)

States: `IDLE → LISTENING → ARA_SPEAKING → WAITING(timer) → POSTING → POSTED`. "Post it" jumps straight to `POSTING`.

```mermaid
sequenceDiagram
  autonumber
  participant D as Driver
  participant A as Android app
  participant X as xAI realtime
  participant T as xAI text API
  participant G as GitHub (inbox)

  D->>A: speaks (audio via car mic)
  A->>X: input_audio_buffer.append (PCM16)
  X-->>A: input_audio_buffer.speech_started
  Note over A: cancel timer (user is talking)
  X-->>A: input_audio_buffer.speech_stopped
  X-->>A: response.output_audio.delta … (played to car)
  X-->>A: response.output_audio.done
  X-->>A: response.done
  Note over A: no response pending → start timer (default 8 s, 5–30 s)
  alt driver speaks again before timeout
    X-->>A: input_audio_buffer.speech_started
    Note over A: cancel timer, continue session
  else timeout fires
    A->>T: summarize transcript + derive pin topic
    T-->>A: {topic, summary}
    A->>G: PUT inbox/<session-id>.json (branch inbox; include sha if it exists)
    G-->>A: 201/200 (commit)
    Note over A: poll inbox/results/<session-id>.json → show status
  end
  opt driver says "post it"
    A->>T: summarize now
    A->>G: PUT immediately (same path, sha-based update)
  end
```

Timer rules:

1. **Start** only on `response.done`, and only if no response is in flight (no pending `response.create`, no
   unfinished function call) and local playback of Ara's audio has drained.
2. **Reset/cancel** on `input_audio_buffer.speech_started`, on any new `response.created`, or on a "Cancel"
   tap in the notification or widget.
3. **Fire** after the configured threshold (default 8 s). Firing summarizes everything said so far in the session.
4. **Fire again later?** If the conversation continues and goes quiet again, the app summarizes the whole session again
   and **updates the same file path** (`inbox/<session-id>.json`) using the file's current `sha`.
   - If the earlier command was already processed (file deleted by the workflow), the PUT creates it again. Today
     `post.mjs` would then add a second page, unless the text is identical (dedup).
   - Once the proposed `sessionId` field lands, the second command will **replace** the first page.
5. **"Post it"** inside the app triggers the same path immediately.

## Failure modes

| Failure | Detection | Handling |
|---------|-----------|----------|
| No network (dead zone) | push throws / non-2xx | Keep the command in a **local persistent queue** (Room/DataStore). Retry with exponential backoff when connectivity returns (WorkManager with a network constraint). The widget shows "queued" |
| Realtime WebSocket drops mid-drive | `onFailure`/`onClosed` | Reconnect with backoff. Use xAI **session resumption** (`resumption.enabled`, `conversation_id`) to keep context. The transcript so far stays local, so a summary is still possible |
| Bluetooth disconnect (car off) | `ACTION_ACL_DISCONNECTED` / companion device gone | Treat as end of session: fire the safety net right away if there's an unposted transcript, then stop the service |
| Ara pauses while "thinking" | no `response.done` yet | Timer doesn't start until `response.done`, so no false fire |
| Driver silent but radio/passenger audible | server VAD detects speech | Timer resets. Worst case it posts later; it never loses data |
| Duplicate summaries | same text / same session | `post.mjs` dedups identical text within 10 min. Same-session replace needs the proposed `sessionId` field. The app updates one file path per session |
| Ambiguous topic | result `skipped_ambiguous` | Log screen shows it. The app can retry with the exact existing pin title from the result's `candidates` |
| GitHub 409/422 on PUT (stale `sha`) | response code | Re-GET the file, take the fresh `sha` (or none if it's gone) and retry once |
| PAT expired/revoked | 401/403 | Notification: "GitHub token invalid, open settings". The command stays queued |
| xAI key invalid / out of credit | 401/402/429 or `error` event | Notification. Fall back to posting the raw last turns (no summary) if the text API fails but a transcript exists |
| Workflow failure (`error` status) | result file status `error` | Command file is kept by the workflow. Re-run the workflow from GitHub Actions |
| Phone killed the service (OEM battery saver) | service restarted / gap in heartbeat | Persistent notification, battery-optimization exemption prompt, foreground service. The transcript is flushed to disk every turn so a restart can still post |
| Built-in Grok used instead (path A) | n/a | Fine: path A posts on "post it". Path B isn't involved |
