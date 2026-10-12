# Transcript poller

The implementation of [issue #4](https://github.com/mogesjohnson/how-to-post-it/issues/4) and
[docs/transcript-automation.md](../docs/transcript-automation.md): it notices when a Grok **voice** conversation has
gone quiet, summarizes it with a **local** model, and pushes one command file to the `inbox` branch of
[mogesjohnson/post-it-board](https://github.com/mogesjohnson/post-it-board/tree/inbox).

**Topic papers:** one pin = one topic, and that pin's **page 1 is one living summary** of the topic (at most
**1,500 characters**). A finished chat about a topic that is already on the board is **merged** into that summary
(an `edit` of page 1) instead of adding another note; a chat about something new **adds** a new pin. A weekly
`--compact` run rewrites summaries that grew past the cap to about 1,000 characters.

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
6. **Match or NEW** (below): read the board's topics, ask the local model whether the chat belongs to one of them.
7. **Matched** → merge the current summary with the new chat → `edit` page 1 of that pin. **NEW** → summarize →
   `add` a new pin with page 1 "Summary".
8. Push the command (exactly the fields `post.mjs --command-file` accepts) *push-if-absent* with the GitHub contents
   API; then read `inbox/results/<name>` on later polls and record the status.

### Topic papers: match, merge, cap

1. **Read the topics** with the board's **public anon key**, read-only (one PostgREST request:
   `pins?select=id,title,…,day:days(board_date),pages(…)`). URL and key come from the site's public
   `config.js` (`BOARD_CONFIG`, or `BOARD_SUPABASE_URL` + `BOARD_SUPABASE_ANON_KEY`); a key whose JWT role is not
   `anon` is refused. Page 1 = first page by `position`, then `created_at` (the same order as `post.mjs`). Topics
   are sorted by their latest `updated_at` (pin or any page); the `MAX_TOPICS` (40) most recent are offered.
   `TOPICS_EXCLUDE` (default `Post-it Board`, the welcome note) is never matched, merged into or compacted.
2. **Match** (one `llama-server` session for the whole decision): the model sees each topic's **name + first line**
   and the transcript, writes the chat's subject in a few words, and picks from a JSON-schema **enum of
   `"NEW"` + the exact topic names**, so it cannot invent a name. A 2B model over-matches when forced to choose,
   so a pick is only accepted if it is **confirmed**. First, the chat must share **at least one distinctive word**
   with the picked topic (the yes/no checks alone once "confirmed" a car-service chat for a bike podcast with zero
   words in common); then:
   - a yes/no question "does subject A belong in note B (name + first line)?", with four worked examples of
     same-thing / different-thing pairs; if no,
   - a yes/no question with **full context**: the note's name + summary (≤ 400 chars) and the chat itself
     (≤ 800 chars), "does the new chat continue this note?"; if no,
   - **anchored word overlap**: ≥ 2 distinctive words shared by the chat and the topic, of which ≥ 1 is an
     *anchor* (a token with a digit such as `1099`, `2x4s`, `16`, or a name capitalized in both texts such as
     `Dana`, `Shinjuku`; weekdays and months don't count) and ≥ 1 is an ordinary word, and no other topic shares as
     many. Ordinary words alone are not enough: a kitchen-cabinet chat shares "stud finder" and "brackets" with a
     garage-shelves topic.
   Otherwise the answer is **NEW**. Measured with `node poller/test/match-eval.mjs` on 26 synthetic chats
   (`test/fixtures/match-suite.json`: 15 follow-ups, 11 unrelated incl. near misses): follow-ups matched
   12/15 → **13–14/15**, unrelated kept NEW 9/11 → **11/11**, wrong merges 2 → **0** (results in docs §2.9). A missed match only costs a duplicate pin; a wrong match would put facts into an
   unrelated paper, so the rules lean towards NEW. If the NEW summary's pin name equals an existing topic, it is
   merged into that topic anyway.
3. **Merge**: current page 1 + the new transcript → one updated summary: decisions first, then open to-dos, then the
   latest facts; a newer statement replaces an older one; facts only.
4. **Numbers guardrail** (for new summaries, merges and compaction): every number and am/pm time in the summary must
   appear in the source (the transcript; for a merge also the current summary; numbers written as words count:
   "forty dollars", "May first", "7 in the evening"). An am/pm the speaker never said is removed ("leave by 11"
   → model wrote "11pm" → "11"). Any other unsupported number: the model is asked **once** to remove it; if it is
   still there, the sentence or bullet holding it is dropped (never the whole summary). The prompt also says to
   copy numbers, times and dates exactly. The log records counts only (`amPmFixed`, `numbersDropped`).
5. **Hard cap 1,500 characters** (`TOPIC_CAP`), for new summaries, merges and compaction alike: repeated
   sentences are dropped first (a small model can loop); if still over, the model is asked **once** more with
   stricter wording ("at most 1200 characters"); if still over, the text is **cut at a sentence/line boundary**. The
   log records `firstLength`, `reasked`, `truncated` and the final length (never the text).
6. **Write**: matched → `{"op":"edit","target":"page","date":"<the topic's day>","pin":"<exact pin title>","pageNumber":1,"body":"…"}`;
   NEW → `{"op":"add","date":"<NY date the chat started>","pin":"…","title":"Summary","body":"…"}`.
   A topic that has a command from another conversation still waiting for its result is not touched until that
   result is in (the conversation waits for the next poll).
7. **Resume**: when a posted conversation continues and goes quiet again, only the messages **after** the last post
   are merged into the same topic (no new match). If that topic was deleted meanwhile, the chat is matched again.

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

The local **Qwen3.5-2B Q4_K_M** model through llama.cpp, started **once per decision** (match + summary/merge in one
session) so no RAM is used while idle:
`llama-server -m /workspace/llm/qwen35-2b-q4km.gguf -t 8 -c <ctx> --no-repack --no-mmproj -np 1` on a free
localhost port, then `POST /v1/chat/completions` with `response_format: json_schema`, `temperature: 0.2`,
`repeat_penalty: 1.1`, `chat_template_kwargs: {enable_thinking: false}`, then the server is stopped. Only one
process uses the model at a time (`model.lock`): if `--compact` holds it, the loop tries again next poll.

- `ctx` fits the transcript plus the topic list / current summary (≈ 3 chars/token + prompt + output), **4096**
  minimum, **16384** maximum. Longer
  transcripts are cut from the **start** (the end is kept) with an "[earlier part … omitted]" marker.
- The prompt asks for **only facts stated in the transcript** and a public-safe note: `pin` (1–4 words),
  `title` (≤ 8 words), `body` (2–4 sentences or 3–6 `- ` bullets; if the model writes more bullets, the first 6
  are kept). A 2B model can still fill in small details, so glance at the first notes.
- If less than `SUMMARIZER_MIN_FREE_MB` (1500) RAM is free, or the model fails, nothing is posted; the health check
  reports `summarizer` and the next poll (with backoff) tries again. It never posts raw transcript text.
- The server's own output is discarded (it could echo the prompt), and the secrets are removed from its environment.

### Commands, file names and results

- **NEW topic:** `{"op":"add","date":"<NY date the conversation started>","pin":"…","title":"Summary","body":"…"}`.
- **Existing topic (matched, or the same conversation resumed):**
  `{"op":"edit","target":"page","date":"<the topic's day>","pin":"<exact pin title>","pageNumber":1,"body":"<merged summary>"}`.
  `post.mjs` needs the exact day and pin title for an edit; both come from the board read (or from the add's result).
- **File name** (docs §4.3): `inbox/auto-<convKey>-<last message UTC YYYYMMDDTHHMMSSZ>-<op>[-r<retry>].json`, where
  `convKey` = first 10 hex chars of `sha256(conversationId)` (the public repo never sees the raw id). Same state →
  same name, so a crash or restart can't post twice (push-if-absent checks `inbox/results/<name>` and
  `inbox/<name>` first, and retries 409/422 with backoff).
- **Compaction** files: `inbox/compact-<sha256(pinId) first 10 hex>-<UTC stamp>.json`.
- **Results:** `ok` / `skipped_duplicate` → posted (records date, exact pin, page number);
  `skipped_not_found` on an edit → the topic is gone: the next poll matches again (a NEW topic gets an `-add` name); `error` → keep waiting (a
  workflow re-run rewrites the result); `error_invalid` / `skipped_ambiguous` / command removed without a result →
  `needs_attention` (fix it, then `node poller/poller.mjs --reset <convKey>`, which bumps the retry suffix).

### Files on the box (`~/.post-it-poller/`, override with `POLLER_HOME`)

| File | What |
|---|---|
| `env` | secrets + settings, **chmod 600** (the poller refuses a group/other-readable file); never committed |
| `state.json` | per conversation: `convKey`, `status`, `lastSeenTs`, `lastLoadedModify`, `lastPostedMsgTime`, `board` (`date`, `pinTitle`, `pageNumber`: the topic it writes to), `pending` command (+ its `topic` and `how`: new/match/same-name/resume), `lastResult`, `retry`; plus `firstRunAt`/`since` |
| `poller.log` | JSON lines: ids (hashed), counts, timestamps, statuses. **Never** message text, cookies or tokens |
| `health.json` | `{ok, lastSuccessAt, lastError, consecutiveFailures, kind, updatedAt, pid}` |
| `poller.lock` | pid of the running poller (one runner at a time) |
| `model.lock` | pid of the process using the local model (loop or `--compact`); a dead pid is taken over |
| `dry-run/` | `--dry-run` state, health and the command/result files it wrote; `dry-run/compact/` for `--compact --dry-run` |

### Health check

Written every loop. `kind` is one of:

| kind | cause | what to do |
|---|---|---|
| `auth` | `401`/`403`, a redirect, or an HTML page (login or Cloudflare/CAPTCHA challenge) instead of JSON; missing `GROK_COOKIE` | sign in to grok.com again and replace `GROK_COOKIE`. **Never** try to bypass a challenge |
| `schema` | expected fields missing (`conversations[]`, `conversationId`, `createTime`, `modifyTime`, `responseNodes[]`, `responses[].sender/message/createTime`) | grok.com changed; the code needs updating |
| `network` | connection errors, `429` (honours `Retry-After`), other HTTP errors | usually transient |
| `summarizer` | model failed or not enough free RAM | check RAM / the model files |
| `push` | GitHub API failure (`401`/`403` = token expired, revoked or missing Contents: write) | renew `INBOX_GITHUB_TOKEN` |
| `board` | the board's topics can't be read (config.js unreachable, Supabase error, a non-anon key) | usually transient; check the site / `BOARD_CONFIG` |

Failures back off exponentially from the poll interval up to `MAX_BACKOFF_SECONDS` (600); **auth** failures up to
`AUTH_MAX_BACKOFF_SECONDS` (1800), since retrying can't fix an expired cookie or a challenge (a new `GROK_COOKIE`
needs a restart anyway): 90 s, 3, 6, 12, 24, then every 30 min, i.e. ≤ 6 requests in the first hour and 2 per hour
after that. A failing cycle stops at the first failing request (it never goes on to the other conversations), and
redirects are never followed. `node poller/test/run.mjs auth` runs these checks.
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
node poller/poller.mjs --compact [--dry-run] [--threshold 1500] [--target 1000] [--json] [--lock-wait 600]
```

### Weekly compaction

```bash
node /workspace/how-to-post-it/poller/poller.mjs --compact            # the weekly routine
node /workspace/how-to-post-it/poller/poller.mjs --compact --dry-run  # report only, pushes nothing
```

- Reads all topics (anon, read-only), selects page-1 summaries **longer than the threshold** (`--threshold`,
  `COMPACT_THRESHOLD`, default 1500), and asks the model to rewrite each to about `--target` characters
  (`COMPACT_TARGET`, default 1000; never more than ⅔ of the threshold). Same cap rules as above.
- A rewrite that is not shorter is left alone (`skipped_not_shorter`). Others are pushed as `edit` page 1 commands
  through the inbox, and the run waits for their results.
- **Never collides with the loop:** it takes `model.lock` (waits up to `--lock-wait` seconds, default 600) and waits
  until the loop's `state.json` has no command waiting for a result; the loop, in turn, defers while compaction holds
  the model. It is safe to run while the poller runs.
- Prints a short report: topics checked, over threshold, compacted, failed, and per topic the before → after
  length and status (`--json` for machine-readable). Exit **0** ok, **1** some topic failed, **75** skipped
  (model or loop busy for too long; try again later).

`READER=browser` is a switch for the C2 fallback (a signed-in browser profile); it is a **TODO stub** that reports
an error.

## Tests

```bash
node poller/test/run.mjs     # unit tests, synthetic fixtures, no network except a local fake server
```

Real-model checks on synthetic chats (each starts the local model once):

```bash
node poller/test/model-merge.mjs   # topic flow: NEW, match, merge, cap, compaction (~1.5 min)
node poller/test/match-eval.mjs    # matching accuracy on test/fixtures/match-suite.json (~2.5 min); exit 1 on a wrong merge
node poller/test/guard-eval.mjs    # numbers guardrail: invented am/pm and numbers, old vs new prompt
```

Mock end to end (fake grok.com + real local model, nothing pushed):

```bash
node poller/test/fake-grok.mjs --port 8787 &            # serves test/fixtures/conversations.json (synthetic); --fixture <file> for another
POLLER_HOME=/tmp/poller-e2e GROK_BASE_URL=http://127.0.0.1:8787 GROK_COOKIE='sso=synthetic' \
  node poller/poller.mjs --once --dry-run --since "$(date -u -d '-1 hour' +%FT%TZ)"
ls /tmp/poller-e2e/dry-run/inbox/
```

The fake server also has `--mode 401|challenge|schema` and test-only `/__admin/append` to simulate a resumed chat.
`POLLER_PIN_OVERRIDE` (testing only) forces the pin title, e.g. `Poller test` for a live inbox test.

Results of the Oct 11, 2026 test run: [docs/transcript-automation.md §2.7](../docs/transcript-automation.md#27-poller-build-and-test-results-oct-11-2026).
Topic papers (Oct 12, 2026): [§2.8](../docs/transcript-automation.md#28-topic-papers-build-and-test-results-oct-12-2026).
