#!/usr/bin/env node
// Post the assistant's summary of one queued chat to the board (through the inbox branch), then drop it from the queue.
//
//   node poller/post-summary.mjs <chatId> --topic "Pin title" --summary-file note.txt   # or --summary "text"
//   node poller/post-summary.mjs <chatId> --skip            # throwaway chat: nothing posted, removed from the queue
//   node poller/post-summary.mjs --list                     # queued chats: id, title, times, transcript length
//
// The note: a chat that was posted before (queue entry has `board`) edits page 1 of that same pin. Otherwise a topic
// whose pin title equals --topic edits page 1 of that pin (write the merged summary), else a new pin is added on the
// chat's day. --dry-run prints the command instead of pushing. Body <= 1,500 characters. Prints no chat text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "./poller.mjs";

const exactCI = s => String(s).replace(/[\ufe0e\ufe0f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();

// Picks the command for this entry. Pure, so tests can call it with a fake topic list.
export function buildCommand(entry, topics, { topic, body, cfg }) {
  if (body.length > P.TOPIC_CAP) throw new Error(`summary is ${body.length} characters; the cap is ${P.TOPIC_CAP}`);
  const open = topics.filter(t => !P.isExcluded(cfg, t));
  const sameAs = b => open.find(t => t.date === b.date && exactCI(t.pinTitle) === exactCI(b.pinTitle));
  let target = entry.board ? sameAs(entry.board) : null;
  if (target) return { how: "resume", cmd: P.editTopicCommand({ ...target, pageNumber: entry.board.pageNumber || 1 }, body) };
  if (!topic) throw new Error("--topic is required for a chat that is not on the board yet");
  target = open.find(t => exactCI(t.pinTitle) === exactCI(topic));
  if (target?.page1) return { how: "match", cmd: P.editTopicCommand(target, body) };
  if (target) return { how: "match", cmd: P.addCommand({ date: target.date, pin: target.pinTitle, body }) };
  return { how: "new", cmd: P.addCommand({ date: entry.boardDate, pin: topic, body }) };
}

async function main(argv) {
  const home = process.env.POLLER_HOME || path.join(os.homedir(), ".post-it-poller");
  P.loadEnvFile(process.env.POLLER_ENV_FILE || path.join(home, "env"));
  const cfg = P.loadConfig(process.env, argv);
  const a = cfg.args, id = argv.find(x => !x.startsWith("--") && !Object.values(a).includes(x));
  const log = P.makeLogger(path.join(cfg.home, "poller.log"), { echo: false });

  if (a.list) {
    const files = fs.existsSync(cfg.queueDir) ? fs.readdirSync(cfg.queueDir).filter(f => f.endsWith(".json")) : [];
    console.log(JSON.stringify(files.map(f => { const e = P.loadState(path.join(cfg.queueDir, f));
      return { chatId: e.chatId, title: e.title, lastMessageTime: e.lastMessageTime, resume: e.resume, board: e.board, filterHint: e.filterHint, transcriptChars: e.transcript.length }; }), null, 2));
    return;
  }
  if (!id) throw new Error("usage: post-summary.mjs <chatId> --topic \"Pin title\" (--summary-file f | --summary \"text\") | --skip | --list");
  const qf = path.join(cfg.queueDir, `${P.safeId(id)}.json`);
  const entry = P.loadState(qf);
  if (!entry) throw new Error(`no queue file ${qf}`);
  const record = board => P.writeJsonAtomic(path.join(cfg.home, "posted", `${P.safeId(id)}.json`), { board, lastTs: entry.lastMessageTime, at: new Date().toISOString() }, 0o600);

  if (a.skip) {
    record(entry.board); fs.unlinkSync(qf);
    log("info", "queue skipped by assistant", { conv: entry.convKey });
    console.log(JSON.stringify({ chatId: id, status: "skipped" })); return;
  }
  const body = (typeof a["summary-file"] === "string" ? fs.readFileSync(a["summary-file"], "utf8") : typeof a.summary === "string" ? a.summary : "").trim();
  if (!body) throw new Error("give the summary with --summary-file <file> or --summary \"text\"");
  const topics = await P.createBoardReader().listTopics();
  const { how, cmd } = buildCommand(entry, topics, { topic: typeof a.topic === "string" ? a.topic : "", body, cfg });
  const name = P.commandFileName(entry.convKey, entry.lastMessageTime, cmd.op);
  if (cfg.dryRun) { console.log(JSON.stringify({ file: name, how, cmd: { ...cmd, body: `<${cmd.body.length} chars>` } }, null, 2)); return; }

  const inbox = P.createGithubInbox({ token: process.env.INBOX_GITHUB_TOKEN, repo: cfg.repo, branch: cfg.branch, api: cfg.githubApi });
  const p = await inbox.pushIfAbsent(name, cmd);
  log("info", "assistant push", { conv: entry.convKey, file: name, op: cmd.op, how, chars: cmd.body.length, state: p.state, commit: p.commit?.slice(0, 7) });
  let r = p.result || null;
  for (let i = 0; !r && i < 60; i++) { await new Promise(res => setTimeout(res, 5000)); r = await inbox.getResult(name); }
  const ok = r && (r.status === "ok" || r.status === "skipped_duplicate");
  if (ok) {
    record({ date: r.date || cmd.date, pinTitle: r.matched?.pinTitle || cmd.pin, pageNumber: (cmd.op === "edit" ? cmd.pageNumber : r.pageNumber) || 1 });
    fs.unlinkSync(qf);
  }
  console.log(JSON.stringify({ chatId: id, file: name, how, op: cmd.op, pin: cmd.pin, date: cmd.date, status: r?.status ?? "no result after 5 min (queue file kept)", queueRemoved: !!ok }, null, 2));
  process.exit(ok ? 0 : 2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => { console.error(JSON.stringify({ level: "fatal", error: e.message })); process.exit(1); });
}
