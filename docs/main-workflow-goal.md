# Documentation - redirection to the specific chat that's pinned in Grok that talks about this whole workflow and our thoughts on it and how we put it all together, and the whole transcription is there

This page explains the project in plain language. If you're new to this repo, start here. The other docs go deeper on each part, and they're linked along the way.

---

## 1. Where this started

Moges talks to Grok in his Tesla. The car's Grok voice assistant is called **Ara**. A lot of good ideas come up during those drives: plans, to-dos, and things worth remembering. They used to vanish when the drive ended.

The goal was simple to state: **save a short summary of each car conversation to a public Post-it board automatically, without touching anything.** He's driving, so the system can't ask him to tap, type, or look at a screen. If he says "post it," Ara should post right away. If he forgets, the system should catch the conversation anyway once it goes quiet.

## 2. What's already built and working

**The board.** The [Post-it Board](https://mogesjohnson.github.io/post-it-board/) is a simple corkboard website. Notes are grouped by **day**, then by **topic pin**, then by **page**, one page per conversation. The site's code is in the [`mogesjohnson/post-it-board`](https://github.com/mogesjohnson/post-it-board) repo and served free by GitHub Pages. The notes themselves are stored in a free **Supabase** database.

**The inbox.** This is how anything, Ara or a script, writes to the board without ever holding a password:

1. The writer pushes a small JSON "command file" to `inbox/<name>.json` on the `inbox` branch of the **post-it-board** repo.
2. That push starts a **GitHub Actions** workflow (`.github/workflows/inbox.yml`) that runs on GitHub's servers.
3. The workflow signs in to Supabase as a dedicated **bot account**, using **encrypted repository secrets**, and runs `scripts/post.mjs`.
4. The note gets **added, edited, or deleted**, and the outcome is written back as `inbox/results/<name>.json`, for example `ok` or `skipped_duplicate`.

This path has been built and tested end to end. The writer only needs permission to push a file. It never sees the Supabase login. The workflow now fails visibly (a red run in GitHub Actions) if it can't push the result back, instead of passing silently.

> Note: the inbox branch lives in **post-it-board**, not in this how-to-post-it repo. This repo holds only documentation.

## 3. The primary plan: transcript automation

The Grok app on the phone **mirrors car conversations** into its chat history, with timestamps. So we don't need anything clever in the car. A script can watch that history from outside.

Here's how it's meant to work:

1. A small script runs on an **always-on machine** that Moges controls.
2. It reads his grok.com conversation history with the same web requests grok.com's own page makes. These are `GET grok.com/rest/app-chat/conversations` to list conversations, and `POST grok.com/rest/app-chat/conversations/{id}/load-responses` to get the messages. It authenticates with his grok.com **session cookie**, which is stored only on that machine.
3. It checks every **1 to 2 minutes**, and only looks at voice chats (`mediaTypes: ["audio"]`).
4. When the newest message's `createTime` and the conversation's `modifyTime` are both at least **10 minutes** old, the conversation counts as finished. The threshold is configurable as `QUIET_MINUTES` (default 10). A note lands about 10 to 12 minutes after the conversation ends.
5. A **local text model** (Qwen3.5-2B on the box) decides which **topic** the chat belongs to. Each pin on the board is one topic, and its **page 1 is one living summary** of that topic, a "topic paper" of at most **1,500 characters**. The script reads the board's topics (read-only), and the model picks one of the existing topic names or `NEW`. Its pick only counts if a second check confirms it, so an unrelated chat never gets merged into the wrong paper.
6. **Matched:** the model merges the current summary with the new chat (decisions, open to-dos and the latest facts first; facts only; hard cap 1,500 characters, re-asked once and then cut at a sentence if it runs over), and the script sends an `edit` of that pin's page 1. **NEW:** it summarizes the chat and sends an `add` for a new pin.
7. The script pushes the inbox command file, and the existing workflow from section 2 posts it to the board.

If the conversation picks up again later, only the new part is merged into the same topic paper instead of creating a duplicate. Once a week, `node /workspace/how-to-post-it/poller/poller.mjs --compact` rewrites any summary that grew past 1,500 characters to about 1,000, through the same inbox; it waits for the running poller so the two never collide.

The board's **Topics** tab (https://mogesjohnson.github.io/post-it-board/#view=topics) lists every topic across all days, most recently updated first, with its summary. The full design, with pseudocode, dedup rules and failure modes, is in [transcript-automation.md](transcript-automation.md) (topic papers: §4.1 and §4.4).

Ara's **"post it"** command is meant to work alongside this: she pushes an inbox file herself, right away. See [ara-instructions.md](ara-instructions.md). It's **untested**: it assumes the car's Grok has a tool that can create files in GitHub, which hasn't been verified, and no `ara-…` result has appeared in the inbox yet.

## 4. The fallback plan (issue #3)

If the REST reads don't work, for example if they return only titles and no text, or xAI blocks them, there's a backup plan. It's tracked in [issue #3](https://github.com/mogesjohnson/how-to-post-it/issues/3):

- A dedicated **Custom Agent** chat in Grok is set up only for summarizing.
- The script pastes the conversation transcript into that chat.
- The agent replies with a summary that ends in a **DONE** marker.
- The script watches for the DONE marker, scrapes the summary, and pushes the inbox file as usual.

This is documentation only for now. Nobody should build it unless the primary plan has been tested and has failed. One open question remains: if the transcript can't be read at all, the fallback still needs another way to get the text to paste in.

## 5. Building it (issue #4)

The actual build is tracked in [issue #4](https://github.com/mogesjohnson/how-to-post-it/issues/4). It covers the transcript reader, the silence loop, the summarizer, the inbox push, and a health check that alerts when sign-in or the data format breaks. The REST test it waited on passed (section 6), so it can start.

## 6. What the test showed, and what's still untested

The REST read was tested on Oct 11, 2026 ([issue #2 results](https://github.com/mogesjohnson/how-to-post-it/issues/2#issuecomment-6114199582)), read-only, in a browser signed in to grok.com:

- **REST reads: verified.** For a **phone voice chat**, `load-responses` returned the **full text of both sides**, not just metadata. The chat was there within about 2 minutes of ending. Voice chats are marked `mediaTypes: ["audio"]`; nothing marks a chat as coming from the car.
- **Timestamps: precise, but they mark the start of a turn.** They're UTC to the millisecond (only in the API, not in the app). Ara's replies are stamped within about 2 seconds of the question, i.e. when she *starts* talking. A seconds-long threshold would cut her off mid-answer, so the threshold is now **10 minutes**.

Still untested: a non-browser client (the script itself), a conversation started **in the car** (expected to look the same), how long the session cookie lasts, and rate limits. Issue #2 stays open until the script reproduces the fetch.

## 7. What Moges still does by hand

- **Change the Supabase owner password.** It showed up in tool logs during setup. This comes first.
- **Create a limited GitHub token** that can only write to the post-it-board repo, for the script's inbox pushes.
- **Pick the always-on machine** the script will run on.
- **Accept, or decline, the terms-of-service risk.** The REST calls are private, undocumented grok.com endpoints. xAI's terms and acceptable-use policy are quoted in [transcript-automation.md](transcript-automation.md) so this can be an informed choice.
- After a few real drives, **tune `QUIET_MINUTES`** (default 10).

The full list is in [setup-checklist.md](setup-checklist.md).

## 8. Why this is safe

- **The public repos hold no secrets.** Anyone can read the code, and that's fine.
- **The Supabase bot login lives in encrypted GitHub Actions secrets.** Only post-it-board's workflows get them, and GitHub masks them in logs (best effort). Any code the inbox workflow runs, meaning `main`'s `scripts/post.mjs`, can read them, so `main` is protected by a branch ruleset ([setup-checklist.md](setup-checklist.md) step 2). They never go in chat or files.
- **The database blocks anonymous writes.** Supabase Row Level Security lets the public key only *read*. Adding, editing, or deleting requires signing in as one of the two approved owner accounts, and public sign-ups are turned off. No all-powerful `service_role` key is used anywhere.
- **The grok.com session cookie stays on the always-on machine.** It's full access to the Grok account, so it never goes in a repo, a secret shared with anyone else, or a chat.
- **One caveat: posted text stays in git history.** Every inbox command and result file holds the full note text in the public post-it-board repo, on the `inbox` branch. Deleting a note from the board doesn't remove it from there; only rewriting that branch's history does. So summaries must never contain anything sensitive.

## How the old phone-app idea fits in

An earlier design used a custom Android app that ran its own voice session and detected silence from voice events. The transcript automation replaced it: there's no app to build and install, no Bluetooth audio, and no xAI voice key. Those docs are kept only as an optional legacy reference. See [ai-studio-prompt.md](ai-studio-prompt.md) and the legacy sections of [architecture.md](architecture.md).
