# Instructions for Ara (built-in car Grok): "post it"

Give these to Ara once (or paste them into her custom instructions). They tell her how to pin notes when
the driver says **"post it"**. This is the second way to post. The primary, automatic way is the
[transcript automation](transcript-automation.md), which summarizes conversations after they go quiet. It skips
the parts Ara already posted, so keep the `ara-` file-name prefix below: that's how her posts are recognized.

> The repository is **mogesjohnson/post-it-board** (branch `inbox`), **not** how-to-post-it.

---

**When the driver says "post it" (or "pin it", "post that"):**

1. Decide the **topic**: 1–4 words naming what we talked about (e.g. "AI agents", "Garage shelves"). Re-use a topic
   from earlier today if it's the same subject. Small differences are fine; the board matches loosely.
2. Write a short **note**: plain text, key points only, at most about 1,200 characters. Use `\n` for line breaks.
3. Create **one file** in GitHub with your GitHub tool:
   - **Repository:** `mogesjohnson/post-it-board`
   - **Branch:** `inbox` (never `main`)
   - **Path:** `inbox/ara-<YYYYMMDDTHHMMSS>-<slug>.json`, using the current New York time and a lowercase slug
     made of letters, digits and hyphens. Example: `inbox/ara-20261005T174512-ai-agents.json`
   - **Commit message:** `inbox: ara note`
   - **Content:** one JSON object (examples below).
4. Say "Posted." The GitHub workflow pins it within about a minute.

**To confirm:** about a minute later, read `inbox/results/<same file name>` on the `inbox` branch.
- `"status": "ok"` means it's on the board.
- Any other status: read `message` and tell the driver in one short sentence.

Or look at the board: https://mogesjohnson.github.io/post-it-board/

## JSON examples

**Add a note** (creates the pin if needed; `date` defaults to today in New York):
```json
{"op": "add", "pin": "AI agents", "title": "Ideas from the drive", "body": "Agents = LLM + tools + loop.\nTry a planner/executor split."}
```

**Edit a page** (needs the exact pin title, plus the exact page title or the page number):
```json
{"op": "edit", "target": "page", "date": "2026-10-05", "pin": "AI agents", "pageNumber": 1, "body": "Corrected: agents = LLM + tools + memory + loop."}
```

**Rename a pin**:
```json
{"op": "edit", "target": "pin", "date": "2026-10-05", "pin": "AI agents", "newPin": "Agents"}
```

**Delete a whole pin** (all its pages too, permanently):
```json
{"op": "delete", "target": "pin", "date": "2026-10-05", "pin": "AI agents"}
```

**Delete one page**:
```json
{"op": "delete", "target": "page", "date": "2026-10-05", "pin": "AI agents", "page": "Ideas from the drive"}
```

## Rules

- **Exact names for edit and delete.** Use the pin title exactly as it appears on the board (case doesn't matter).
  If unsure, add a new note instead or ask the driver. The board never guesses for edit/delete; it returns
  `skipped_not_found` or `skipped_ambiguous`.
- **Deletes are permanent.** Only delete when the driver clearly asks, and repeat the pin name back first.
- **One command per file.** Always use a new, unique file name.
- **Never put secrets in files:** no passwords, tokens, API keys, addresses of other people, or anything the driver
  wants private. **The repo and the board are public.**
- **Never touch other branches or files.** Only create files under `inbox/` on the `inbox` branch.
- **Always confirm out loud with "Posted."** The transcript automation looks for "post it" followed by your
  confirmation to avoid posting the same conversation a second time.
- **"Don't post this":** if the driver says it, don't post, and acknowledge briefly. The automation also skips
  conversations containing that phrase.
- Limits: pin and title ≤ 200 characters, body ≤ 5000.
- Statuses you may see: `ok`, `skipped_duplicate` (same text already added in the last 10 min),
  `skipped_ambiguous`, `skipped_not_found`, `error_invalid` (fix the JSON), `error` (temporary; the owner can
  re-run the workflow).

Full format reference: [post-it-board inbox/README.md](https://github.com/mogesjohnson/post-it-board/blob/inbox/inbox/README.md).
