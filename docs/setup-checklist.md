# Setup checklist (things you do by hand)

Work through these in order. None of them should leave a secret in this repo or in the app source.

## 1. Change your Supabase owner password (do this first)

Your owner account's password (johnsonmoges@gmail.com) showed up in tool logs while the board was being built, so
treat it as exposed.

1. Open https://supabase.com/dashboard/project/hooxyhsuckpekksdoytw → **Authentication → Users**.
2. Find `johnsonmoges@gmail.com` → **⋯ → Send password recovery** (or reset it directly), then set a new strong
   password from your password manager.
3. Sign in on https://mogesjohnson.github.io/post-it-board/ with the new password to confirm it works.

You don't need to change the inbox: the workflow signs in as the separate **bot** account
(`johnsonmoges+postit-bot@gmail.com`), and its password lives only in the post-it-board Actions secret
`SUPABASE_OWNER_PASSWORD`. To rotate the bot too: reset it in the same Users screen, then update that secret under
post-it-board → Settings → Secrets and variables → Actions.

## 2. Create a fine-grained GitHub token for the app

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** mogesjohnson. **Expiration:** 90 days or less (put a renewal reminder in your calendar).
3. **Repository access:** *Only select repositories* → **mogesjohnson/post-it-board** only.
4. **Permissions → Repository permissions → Contents: Read and write.** Leave everything else as *No access*
   (Metadata: read-only is added automatically).
5. Copy the token straight into the app's Settings screen (step 5). Don't paste it into notes, chats, or this repo.

If the phone is lost or the token leaks, revoke it on the same page. The worst it can do is push to post-it-board.

## 3. Get an xAI API key

1. Sign in at https://console.x.ai → **API Keys → Create**. Give it a name like `how-to-post-it-phone`.
2. Check the current price per minute of realtime voice on xAI's pricing page, and set a spending limit or alert on
   the team if the console offers one.
3. If the app ends up using ephemeral client secrets (`POST /v1/realtime/client_secrets`), the long-lived key
   still lives in the app or a proxy. See *Secrets model* in the README.

## 4. Generate the app in Google AI Studio

1. Open https://aistudio.google.com → **Build** → choose the Android / Kotlin target, if your account offers it.
2. Paste the whole prompt from [`ai-studio-prompt.md`](ai-studio-prompt.md).
3. Review the generated code. In particular, check that:
   - no key or token appears anywhere in the source,
   - the GitHub path is `mogesjohnson/post-it-board`, branch `inbox`, folder `inbox/`,
   - the timer starts only after `response.done`.
4. Export or download the project, then open it in Android Studio for real builds. AI Studio's emulator can't test
   Bluetooth, the car, or audio routing.

## 5. Install on a real Android phone

1. Phone: **Settings → About phone → tap Build number 7×** → **Developer options → USB debugging: on**.
2. Connect USB → accept the RSA prompt → `adb devices` shows the phone.
3. Install with Android Studio's ▶ button, or `./gradlew installDebug`, or `adb install app-debug.apk`.
4. Open the app → Settings, then:
   - paste the GitHub token and the xAI key,
   - pick the voice (`ara`),
   - leave the threshold at 8 s,
   - grant microphone, notifications, and nearby devices (Bluetooth) permissions.
5. Battery: set the app to **Unrestricted** (Settings → Apps → Post-it Drive → Battery). On Samsung, Xiaomi, or
   OnePlus phones, also remove it from any "sleeping apps" list (see https://dontkillmyapp.com).
6. Tap **Send test pin** in Settings, if the generated app has it. Otherwise run
   `scripts/send-test-command.sh` from a computer. Then delete the test pin.

## 6. Pair with the car

1. Pair the phone with the Tesla as usual (phone + media audio both enabled).
2. In the app: **Settings → Car → Associate car**. This runs the CompanionDeviceManager picker; choose the car's
   Bluetooth entry.
3. Get in the car, confirm the "Armed" notification appears on connect, and tap **Start** once. On Android 14+, the
   mic can't start from the background on its own.
4. Talk to Ara through the car speakers. Check that her voice plays in the car and your voice is heard. If audio
   stays on the phone speaker, switch the app's audio route setting (media vs. communication/SCO).

## 7. Tune the safety-net threshold after real drives

- Start at **8 s**. If it posts while you're still thinking, raise it (12–15 s). If it posts too late after you
  stop, lower it (5–6 s).
- Check the log screen. Each session should produce one page on the board, and later fires should update that same
  file, not create duplicates.
- Expect duplicates on the board until the `sessionId` follow-up lands in post-it-board (README → *The working design* and *Status*).

## 8. Optional: Play Console internal testing

- For easy updates without adb: create an app in Play Console ($25 one-time developer fee), upload a signed AAB to
  **Internal testing**, and add yourself as a tester.
- Declare the foreground service types (microphone, connectedDevice, mediaPlayback) and the microphone data use in
  the Play Console forms.
- Keep the signing keystore out of git (`.gitignore` already excludes `*.jks` / `*.keystore`).
