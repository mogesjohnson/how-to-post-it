# Transcript poller

The implementation of [issue #4](https://github.com/mogesjohnson/how-to-post-it/issues/4) and
[docs/transcript-automation.md](../docs/transcript-automation.md): it notices when a Grok **voice** conversation has
gone quiet, summarizes it with a **local** model, and pushes one command file to the `inbox` branch of
[mogesjohnson/post-it-board](https://github.com/mogesjohnson/post-it-board/tree/inbox). If the conversation continues
later, it **edits** the same page instead of adding a second one.

- `poller.mjs`: the whole thing. Node 18+, no dependencies (built-in `fetch`).
- `start.sh`: start / stop / status in the background (nohup).
- `.env.example`: the settings, with placeholder values only.
- `test/`: unit tests, a fake grok.com server and **synthetic** fixtures.

> ⚠️ It reads grok.com's **undocumented** `/rest/app-chat/` endpoints with your session cookie. That is automated
> access in tension with xAI's Acceptable Use Policy ([§2.3](../docs/transcript-automation.md#23-what-xais-terms-say)),
> and the cookie is full access to your Grok account. The poller is read-only, polls page 1 of the list every 60–120 s,
> never runs requests in parallel, honours `429`/`Retry-After`, and **stops and alerts on a challenge page** instead of
> trying to get around it.

## How it works

Every `POLL_SECONDS` (default 90, clamped to 60–120):

1. `GET https://grok.com/rest/app-chat/conversations?pageSize=60`: page 1 only (most recent).
2. Keep conversations whose `mediaTypes` contains `"audio"` and whose `modifyTime` is after the poller's
   **first-run start time** (no backfill; `--since <ISO time>` overrides it).
3. A conversation whose `modifyTime` is younger than `QUIET_MINUTES` is still active: nothing is loaded.
   Otherwise, if it changed since the last load, its messages are loaded (below). Bodies stay in memory only.
4. **Finished** when `now − max(newest message createTime, modifyTime) ≥ QUIET_MINUTES` (default 10).
   `createTime` marks when a turn *starts*, hence minutes, not seconds. If a timestamp is > 1 min in the future
   (clock skew), it falls back to "how long the newest message has been the newest by our clock".
5. Skip it if you said an opt-out phrase ("don't post this", "do not post", "off the record"); only summarize what
   came after Ara's "Posted." if you said "post it" during the drive.
6. Summarize with the local model → `{pin, title, body}`.
7. Build the command (exactly the fields `post.mjs --command-file` accepts) and push it, *push-if-absent*, with the
   GitHub contents API; then read `inbox/results/<name>` on later polls and record the status.

### Loading messages (the exact request shape)

From [pinguarmy/ai-chat-exporter `src/lib/grok-api.ts`](https://github.com/pinguarmy/ai-chat-exporter/blob/main/src/lib/grok-api.ts)
(`fetchGrokConversationDetail`) and [0xSMW/swift-grok `GrokClient+Conversations.swift`](https://github.com/0xSMW/swift-grok/blob/main/Sources/GrokClient/Endpoints/GrokClient%2BConversations.swift)
(`loadResponses`), which agree:

```text
GET  https://grok.com/rest/app-chat/conversations/{id}/response-node
     -> {"responseNodes":[{"responseId","sender","parentResponseId"}...], "inflightResponses":[...]}
POST https://grok.com/rest/app-chat/conversations/{id}/load-responses
     content-type: application/json
     body: {"responseIds": ["<every responseId from response-node, in order, de-duplicated>"]}
     -> {"responses":[{"responseId","sender":"human"|"assistant","message","createTime",...}...]}
```

Headers on every request (browser-like, after swift-grok's `GrokClientCore.headers`): `cookie: $GROK_COOKIE`,
a desktop Chrome `user-agent`, `accept: */*`, `accept-language`, `referer: https://grok.com/`,
`sec-fetch-dest/mode/site`, plus `content-type` and `origin: https://grok.com` on the POST. Not sent:
swift-grok's generated `x-statsig-id` and `x-xai-request-id` (ai-chat-exporter works without them; add them only if
grok.com starts rejecting requests). Redirects are not followed (a redirect counts as an auth failure).

### Summarizer

The local **Qwen3.5-2B Q4_K_M** model through llama.cpp, started **per summary** so no RAM is used while idle:
`llama-server -m /workspace/llm/qwen35-2b-q4km.gguf -t 8 -c <ctx> --no-repack --no-mmproj -np 1` on a free
localhost port, then `POST /v1/chat/completions` with `response_format: json_schema`, `temperature: 0.2`,
`chat_template_kwargs: {enable_thinking: false}`, then the server is stopped.

- `ctx` fits the transcript (≈ 3 chars/token + prompt + output), **4096** minimum, **16384** maximum. Longer
  transcripts are cut from the **start** (the end is kept) with an "[earlier part … omitted]" marker.
- The prompt asks for **only facts stated in the transcript** and a public-safe note: `pin` (1–4 words),
  `title` (≤ 8 words), `body` (2–4 sentences or 3–6 `- ` bullets; if the model writes more bullets, the first 6
  are kept). A 2B model can still fill in small details, so glance at the first notes.
- If less than `SUMMARIZER_MIN_FREE_MB` (1500) RAM is free, or the model fails, nothing is posted; the health check
  reports `summarizer` and the next poll (with backoff) tries again. It never posts raw transcript text.
- The server's own output is discarded (it could echo the prompt), and the secrets are removed from its environment.

### Commands, file names and results

- **First post:** `{"op":"add","date":"<NY date the conversation started>","pin":"…","title":"<title> (9:15 PM)","body":"…"}`.
  The start time in the page title makes it unique and stable; a pin title the poller already used that day is
  reused exactly.
- **Resumed and quiet again:** `{"op":"edit","target":"page","date":…,"pin":"<matched.pinTitle from the add's result>","page":"<that page title>","body":"<new summary of the whole conversation>"}`
  (`pageNumber` instead of `page` only if the page has no title).
- **File name** (docs §4.3): `inbox/auto-<convKey>-<last message UTC YYYYMMDDTHHMMSSZ>-<op>[-r<retry>].json`, where
  `convKey` = first 10 hex chars of `sha256(conversationId)` (the public repo never sees the raw id). Same state →
  same name, so a crash or restart can't post twice (push-if-absent checks `inbox/results/<name>` and
  `inbox/<name>` first, and retries 409/422 with backoff).
- **Results:** `ok` / `skipped_duplicate` → posted (records date, exact pin, page title/number);
  `skipped_not_found` on an edit → forget the page, the next poll sends a fresh `add`; `error` → keep waiting (a
  workflow re-run rewrites the result); `error_invalid` / `skipped_ambiguous` / command removed without a result →
  `needs_attention` (fix it, then `node poller/poller.mjs --reset <convKey>`, which bumps the retry suffix).

### Files on the box (`~/.post-it-poller/`, override with `POLLER_HOME`)

| File | What |
|---|---|
| `env` | secrets + settings, **chmod 600** (the poller refuses a group/other-readable file); never committed |
| `state.json` | per conversation: `convKey`, `status`, `lastSeenTs`, `lastLoadedModify`, `lastPostedMsgTime`, `board` (`date`, `pinTitle`, `pageTitle`, `pageNumber`), `pending` command, `lastResult`, `retry`; plus `since` and the pins used |
| `poller.log` | JSON lines: ids (hashed), counts, timestamps, statuses. **Never** message text, cookies or tokens |
| `health.json` | `{ok, lastSuccessAt, lastError, consecutiveFailures, kind, updatedAt, pid}` |
| `poller.lock` | pid of the running poller (one runner at a time) |
| `dry-run/` | `--dry-run` state, health and the command/result files it wrote |

### Health check

Written every loop. `kind` is one of:

| kind | cause | what to do |
|---|---|---|
| `auth` | `401`/`403`, a redirect, or an HTML page (login or Cloudflare/CAPTCHA challenge) instead of JSON; missing `GROK_COOKIE` | sign in to grok.com again and replace `GROK_COOKIE`. **Never** try to bypass a challenge |
| `schema` | expected fields missing (`conversations[]`, `conversationId`, `createTime`, `modifyTime`, `responseNodes[]`, `responses[].sender/message/createTime`) | grok.com changed; the code needs updating |
| `network` | connection errors, `429` (honours `Retry-After`), other HTTP errors | usually transient |
| `summarizer` | model failed or not enough free RAM | check RAM / the model files |
| `push` | GitHub API failure (`401`/`403` = token expired, revoked or missing Contents: write) | renew `INBOX_GITHUB_TOKEN` |

Failures back off exponentially from the poll interval up to `MAX_BACKOFF_SECONDS` (600).
`node poller/poller.mjs --health` (or `poller/start.sh status`) prints it and exits **1** if the last loop failed or
the heartbeat is stale (no loop for ~12 min).

## Running it

```bash
mkdir -p ~/.post-it-poller && chmod 700 ~/.post-it-poller
cp poller/.env.example ~/.post-it-poller/env && chmod 600 ~/.post-it-poller/env
$EDITOR ~/.post-it-poller/env        # GROK_COOKIE and INBOX_GITHUB_TOKEN
poller/start.sh                      # background (nohup); the first run records "now" as the no-backfill start
poller/start.sh status               # running? + health; exit 1 if unhealthy
poller/start.sh stop                 # stop it (or: kill "$(cat ~/.post-it-poller/poller.lock)")
tail -f ~/.post-it-poller/poller.log
```

It does not restart itself after a reboot; add `@reboot /path/to/poller/start.sh` to `crontab -e` if you want that.

Other commands:

```bash
node poller/poller.mjs --once [--wait]                  # one cycle; --wait polls only the inbox results for up to 5 min
node poller/poller.mjs --dry-run --once                 # write commands to ~/.post-it-poller/dry-run/inbox/ instead of pushing
node poller/poller.mjs --since 2026-10-11T20:00:00Z     # move the no-backfill start time (saved in state.json)
node poller/poller.mjs --summarize-file transcript.txt  # run only the summarizer and print JSON + timings
node poller/poller.mjs --send-command cmd.json --name my-file.json   # push one command by hand and wait for its result
node poller/poller.mjs --reset <convKey>                # retry a needs_attention conversation
```

`READER=browser` is a switch for the C2 fallback (a signed-in browser profile); it is a **TODO stub** that reports
an error.

## Tests

```bash
node poller/test/run.mjs     # unit tests, synthetic fixtures, no network except a local fake server
```

Mock end to end (fake grok.com + real local model, nothing pushed):

```bash
node poller/test/fake-grok.mjs --port 8787 &            # serves test/fixtures/conversations.json (synthetic)
POLLER_HOME=/tmp/poller-e2e GROK_BASE_URL=http://127.0.0.1:8787 GROK_COOKIE='sso=synthetic' \
  node poller/poller.mjs --once --dry-run --since "$(date -u -d '-1 hour' +%FT%TZ)"
ls /tmp/poller-e2e/dry-run/inbox/
```

The fake server also has `--mode 401|challenge|schema` and test-only `/__admin/append` to simulate a resumed chat.
`POLLER_PIN_OVERRIDE` (testing only) forces the pin title, e.g. `Poller test` for a live inbox test.

Results of the Oct 11, 2026 test run: [docs/transcript-automation.md §2.7](../docs/transcript-automation.md#27-poller-build-and-test-results-oct-11-2026).
