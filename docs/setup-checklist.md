# Setup checklist (things you do by hand)

Work through these in order. None of them should leave a secret in this repo, in post-it-board, or in any script.
Steps 1–7 are for the **primary path** (transcript automation + Ara's "post it"). The old Android app steps are at
the end, marked **legacy / optional**.

## 1. Change your Supabase owner password (do this first)

Your owner account's password (johnsonmoges@gmail.com) showed up in tool logs while the board was being built, so
treat it as exposed.

1. Open https://supabase.com/dashboard/project/hooxyhsuckpekksdoytw → **Authentication → Users**.
2. Find `johnsonmoges@gmail.com` → **⋯ → Send password recovery** (or reset it directly), then set a new strong
   password from your password manager.
3. Sign in on https://mogesjohnson.github.io/post-it-board/ with the new password to confirm it works.

You don't need to change the inbox or the automation: the workflow signs in as the separate **bot** account
(`johnsonmoges+postit-bot@gmail.com`), and its password lives only in the post-it-board Actions secret
`SUPABASE_OWNER_PASSWORD`. To rotate the bot too: reset it in the same Users screen, then update that secret under
post-it-board → Settings → Secrets and variables → Actions.

## 2. Create a fine-grained GitHub token for the automation

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** mogesjohnson. **Expiration:** 90 days or less (put a renewal reminder in your calendar).
3. **Repository access:** *Only select repositories* → **mogesjohnson/post-it-board** only.
4. **Permissions → Repository permissions → Contents: Read and write.** Leave everything else as *No access*
   (Metadata: read-only is added automatically).
5. Put the token straight into the secret store of whatever runs the automation (OS keychain, a service's
   environment, or an Actions secret in a **private** repo). Don't paste it into notes, chats, or any repo.

If the token leaks, revoke it on the same page. It can push to post-it-board: post or delete notes through the inbox,
change the site on `main`, or change `main`'s `scripts/post.mjs`, which the inbox workflow runs with the Supabase bot
secrets, so it could steal the bot password. **Protect `main` with a ruleset (recommended, not optional):**
post-it-board → **Settings → Rules → Rulesets → New branch ruleset**, target the default branch, turn on
*Require a pull request before merging* and *Block force pushes*, and add **Repository admin** to the bypass list with
the mode **For pull requests only**. The token acts as you, so a bypass set to *Always* would let it push to `main` too.

## 3. Check what the transcript looks like on your phone

After a short drive where you talk to Grok in the car, open the **Grok app on your phone → history** and note:

- [ ] the car conversation is there, and how long after you spoke it appeared;
- [ ] the timestamp format: seconds, minutes only, or relative ("2 min ago");
- [ ] whether a timestamp marks the start or the end of a message;
- [ ] whether anything marks it as a car conversation (title, icon, mode);
- [ ] whether one drive is one conversation or several.

These answers decide how precise silence detection can be. See
[transcript-automation.md §1](transcript-automation.md#1-how-transcript-mirroring-works).

## 4. Choose and set up the transcript reader

**This is the unverified part.** There is no public, documented xAI/Grok API for reading consumer conversation
history. Research (Oct 5, 2026) found the grok.com web app's own undocumented `/rest/app-chat/` endpoints, used by
third-party tools with your session cookies. Evaluate the options in [transcript-automation.md §2](transcript-automation.md#2-reading-the-transcript-unverified-choose-one):

**Recommended (from [§2.5](transcript-automation.md#25-recommendation)):** primary = **C1, REST reads with your
grok.com session**, on an always-on machine you control; fallback = **C2, browser automation with a persistent
signed-in profile**. Keep both behind one `READER=rest|browser` flag. First, **read xAI's terms**
([§2.3](transcript-automation.md#23-what-xais-terms-say)) and decide if you accept the account risk; if not, use D + A only.

- [ ] **Test the key unknown first:** confirm a **car** conversation's **text** is actually readable (not just title +
      timestamps). One archiver reports voice conversations expose only metadata. If car transcripts aren't readable,
      none of C1/C2 help and you fall back to D.
- [ ] **C1. REST reads (primary):** on an always-on machine, extract your grok.com session cookies and store them
      **only** there (file with `600` perms, OS keychain, or an encrypted secret) — **never** in this repo, an inbox
      file, or chat (a cookie is full account access). Poll the list every 5–10 s only while a conversation is active,
      back off otherwise, load bodies only when a conversation changed, read-only, your own account only, honour 429s.
- [ ] **C2. Browser automation (fallback):** a persistent browser profile logged in as you, for when C1 is challenged
      or its cookie expires. Guard the whole profile directory like a password. Do **not** use "anti-bot bypass".
- [ ] **A. Official API or export:** check grok.com → Settings → Data Controls and xAI's docs for anything newer than
      the manual account-data ZIP (good only for a manual backfill).
- [ ] **B. Grok Automation:** test whether a scheduled Automation can list your other conversations and push a file to
      GitHub; if so, use it as a daily catch-up.
- [ ] **D. Ara posts it:** needs no reader, but is untested (step 6).

Then:

1. Implement the loop from [transcript-automation.md §3](transcript-automation.md#3-the-silence-detection-loop)
   behind the reader adapter, with the `READER` flag. Start in a **dry-run mode** that prints the command JSON
   instead of pushing it.
2. **Run the reader on an always-on machine you control, not GitHub Actions cron** (5-minute minimum defeats the 8 s
   threshold, and datacenter IPs trip challenges). Keep GitHub only for applying inbox files.
3. Wire up the **health check**: alert on auth failure, a challenge page, a schema change, missing results, `error`
   results, and a missing heartbeat ([§7](transcript-automation.md#health-check-and-reader-failover)).

## 5. Test the inbox end to end

1. From a computer with `gh` signed in: `scripts/send-test-command.sh`. It pushes a clearly named test note and
   prints the result. **This writes to the live board.**
2. Delete the test pin: copy `templates/command-delete.json` to a scratch file and set `pin` to `how-to-post-it test`.
   It has no `date`, so it targets today in New York, the same day as the test note (add `"date"` only if the note is
   on another day). Then run `scripts/send-test-command.sh <that file>`.
3. Turn off dry-run in the automation, have a short test conversation in the car, and confirm one `auto-…` page shows
   up. Keep talking in a later session of the same conversation and confirm the **same page is edited**, not a
   second one added.

## 6. Give Ara her "post it" instructions

Paste [ara-instructions.md](ara-instructions.md) into Ara's custom instructions, or tell her once. Say "post it" on a
test drive and check that `inbox/results/ara-….json` shows `ok`.

- [ ] **Confirm Ara can write to GitHub at all.** This path is untested: it assumes the in-car Grok has a tool that
      can create a file in a GitHub repo, which hasn't been verified, and no `ara-…` result has appeared in the inbox
      yet. If she can't, the transcript automation is the only automatic path.

## 7. Tune the silence threshold after real drives

- Start at **8 s** (allowed range **5–30 s**). If it posts while you're still thinking or mid-conversation, raise it
  (12–15 s) and/or the "your turn" grace period. If you want notes sooner, lower it (5–6 s), but remember the poll
  interval usually matters more than the threshold.
- Check after each drive: one page per conversation, continued conversations edit that page, nothing private posted.
- If you see duplicates, check that the automation skips what Ara already posted
  ([transcript-automation.md §6](transcript-automation.md#6-idempotency-and-dedup)).

---

## Legacy (optional): Android voice app (superseded)

> **Superseded.** Only needed if you decide to build the old custom voice app after all
> ([ai-studio-prompt.md](ai-studio-prompt.md)). The xAI API key and the AI Studio app are **not** needed for the
> primary path.

### L1. Get an xAI API key

1. Sign in at https://console.x.ai → **API Keys → Create**. Give it a name like `how-to-post-it-phone`.
2. Check the current price per minute of realtime voice on xAI's pricing page, and set a spending limit or alert on
   the team if the console offers one.
3. If the app ends up using ephemeral client secrets (`POST /v1/realtime/client_secrets`), the long-lived key
   still lives in the app or a proxy. See the legacy secrets notes in [ai-studio-prompt.md](ai-studio-prompt.md).

### L2. Generate the app in Google AI Studio

1. Open https://aistudio.google.com → **Build** → choose the Android / Kotlin target, if your account offers it.
2. Paste the whole prompt from [`ai-studio-prompt.md`](ai-studio-prompt.md).
3. Review the generated code. In particular, check that:
   - no key or token appears anywhere in the source,
   - the GitHub path is `mogesjohnson/post-it-board`, branch `inbox`, folder `inbox/`,
   - the timer starts only after `response.done`.
4. Export or download the project, then open it in Android Studio for real builds. AI Studio's emulator can't test
   Bluetooth, the car, or audio routing.

### L3. Install on a real Android phone

1. Phone: **Settings → About phone → tap Build number 7×** → **Developer options → USB debugging: on**.
2. Connect USB → accept the RSA prompt → `adb devices` shows the phone.
3. Install with Android Studio's ▶ button, or `./gradlew installDebug`, or `adb install app-debug.apk`.
4. Open the app → Settings, then:
   - paste a GitHub token (same kind as step 2, ideally a separate one for the phone) and the xAI key,
   - pick the voice (`ara`),
   - leave the threshold at 8 s,
   - grant microphone, notifications, and nearby devices (Bluetooth) permissions.
5. Battery: set the app to **Unrestricted** (Settings → Apps → Post-it Drive → Battery). On Samsung, Xiaomi, or
   OnePlus phones, also remove it from any "sleeping apps" list (see https://dontkillmyapp.com).
6. Tap **Send test pin** in Settings, if the generated app has it. Otherwise run
   `scripts/send-test-command.sh` from a computer. Then delete the test pin.

### L4. Pair with the car

1. Pair the phone with the Tesla as usual (phone + media audio both enabled).
2. In the app: **Settings → Car → Associate car**. This runs the CompanionDeviceManager picker; choose the car's
   Bluetooth entry.
3. Get in the car, confirm the "Armed" notification appears on connect, and tap **Start** once. On Android 14+, the
   mic can't start from the background on its own.
4. Talk to Ara through the car speakers. Check that her voice plays in the car and your voice is heard. If audio
   stays on the phone speaker, switch the app's audio route setting (media vs. communication/SCO).

### L5. Tune the app's safety-net threshold

- Start at **8 s**. If it posts while you're still thinking, raise it (12–15 s). If it posts too late after you
  stop, lower it (5–6 s).
- Check the log screen. Each session should produce one page on the board, and later fires should update that same
  file, not create duplicates.
- Expect occasional duplicates: the proposed `sessionId` replace semantics were never implemented in post-it-board.

### L6. Optional: Play Console internal testing

- For easy updates without adb: create an app in Play Console ($25 one-time developer fee), upload a signed AAB to
  **Internal testing**, and add yourself as a tester.
- Declare the foreground service types (microphone, connectedDevice, mediaPlayback) and the microphone data use in
  the Play Console forms.
- Keep the signing keystore out of git (`.gitignore` already excludes `*.jks` / `*.keystore`).
