// Local fake of the grok.com REST endpoints the poller reads, serving SYNTHETIC fixtures.
//   node poller/test/fake-grok.mjs [--port 8787] [--mode ok|401|challenge|schema] [--now 2026-10-05T23:00:00Z] [--fixture file.json]
// Admin (test only): POST /__admin/mode {"mode":"401"} · POST /__admin/append {"conversationId", "messages":[{sender,minAgo,message}]}
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function startFakeGrok({ port = 0, mode = "ok", fixture = path.join(here, "fixtures/conversations.json"), nowMs = Date.now() } = {}) {
  const fx = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const iso = minAgo => new Date(nowMs - minAgo * 60_000).toISOString();
  const convs = fx.conversations.map(c => {
    const responses = c.messages.map((m, i) => ({ responseId: `${c.conversationId}-r${i}`, sender: m.sender, message: m.message, createTime: iso(m.minAgo), mediaTypes: ["audio"] }));
    return { ...c, responses };
  });
  const meta = c => ({
    conversationId: c.conversationId, title: c.title, starred: false, mediaTypes: c.mediaTypes,
    createTime: c.responses[0].createTime,
    modifyTime: c.responses.reduce((a, r) => (r.createTime > a ? r.createTime : a), c.responses[0].createTime),
  });
  const stats = { list: 0, responseNode: 0, loadResponses: 0, badCookie: 0 };
  let curMode = mode;
  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/__admin/mode") { curMode = JSON.parse(body).mode; return json(res, 200, { mode: curMode }); }
      if (url.pathname === "/__admin/append") {
        const { conversationId, messages } = JSON.parse(body);
        const c = convs.find(x => x.conversationId === conversationId);
        for (const m of messages) c.responses.push({ responseId: `${conversationId}-r${c.responses.length}`, sender: m.sender, message: m.message, createTime: iso(m.minAgo) });
        return json(res, 200, { count: c.responses.length });
      }
      if (url.pathname === "/__admin/stats") return json(res, 200, stats);
      if (!/(^|;\s*)sso=/.test(req.headers.cookie || "")) { stats.badCookie++; return json(res, 401, { error: "unauthenticated" }); }
      if (!/Mozilla\/5\.0/.test(req.headers["user-agent"] || "")) return json(res, 403, { error: "bad ua" });
      if (curMode === "401") return json(res, 401, { error: "unauthenticated" });
      if (curMode === "challenge") { res.writeHead(403, { "content-type": "text/html" }); return res.end("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id=\"cf-chl\">challenge-platform</div></body></html>"); }
      let m;
      if (req.method === "GET" && url.pathname === "/rest/app-chat/conversations") {
        stats.list++;
        const list = convs.map(meta).sort((a, b) => (a.modifyTime < b.modifyTime ? 1 : -1));
        if (curMode === "schema") return json(res, 200, { conversations: list.map(({ modifyTime, ...rest }) => rest), nextPageToken: "" });
        return json(res, 200, { conversations: list, nextPageToken: "tok-2", textSearchMatches: [] });
      }
      if (req.method === "GET" && (m = /^\/rest\/app-chat\/conversations\/([^/]+)\/response-node$/.exec(url.pathname))) {
        stats.responseNode++;
        const c = convs.find(x => x.conversationId === decodeURIComponent(m[1]));
        if (!c) return json(res, 404, { error: "not found" });
        return json(res, 200, { responseNodes: c.responses.map((r, i) => ({ responseId: r.responseId, sender: r.sender, parentResponseId: i ? c.responses[i - 1].responseId : undefined })), inflightResponses: [] });
      }
      if (req.method === "POST" && (m = /^\/rest\/app-chat\/conversations\/([^/]+)\/load-responses$/.exec(url.pathname))) {
        stats.loadResponses++;
        const c = convs.find(x => x.conversationId === decodeURIComponent(m[1]));
        let ids; try { ids = JSON.parse(body).responseIds; } catch {}
        if (!c || !Array.isArray(ids)) return json(res, 400, { error: "bad request" });
        return json(res, 200, { responses: c.responses.filter(r => ids.includes(r.responseId)) });
      }
      json(res, 404, { error: "no route" });
    });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, stats, setMode: x => (curMode = x), close: () => new Promise(r => server.close(r)), convs });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const get = (k, d) => (a.includes(`--${k}`) ? a[a.indexOf(`--${k}`) + 1] : d);
  const s = await startFakeGrok({ port: Number(get("port", 8787)), mode: get("mode", "ok"), ...(get("fixture") ? { fixture: path.resolve(get("fixture")) } : {}), nowMs: get("now") ? Date.parse(get("now")) : Date.now() });
  console.log(`fake grok listening on ${s.url}`);
}
