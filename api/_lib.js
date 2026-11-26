import crypto from "node:crypto";

import net from "node:net";
import tls from "node:tls";

/* Redis-kapcsolat felismerése: bármilyen előtagú REST-változó (pl. KV_, UPSTASH_, STORAGE_KV_),
   vagy egy sima redis:// / rediss:// cím (REDIS_URL, *_REDIS_URL). */
const env = process.env;
const findKey = re => Object.keys(env).find(k => re.test(k) && env[k]);
const restUrlKey = findKey(/(^|_)(KV_REST_API_URL|REDIS_REST_URL)$/);
const restTokKey = restUrlKey && (restUrlKey.replace(/URL$/, "TOKEN") in env ? restUrlKey.replace(/URL$/, "TOKEN") : findKey(/(^|_)(KV_REST_API_TOKEN|REDIS_REST_TOKEN)$/));
const tcpKey = findKey(/(^|_)(REDIS_URL|KV_URL)$/) ;
let REST_URL = restUrlKey ? env[restUrlKey] : "", REST_TOKEN = restTokKey ? env[restTokKey] : "";
let TCP = null;
if (!REST_URL && tcpKey) {
  try {
    const u = new URL(env[tcpKey]);
    if (/upstash\.io$/.test(u.hostname) && u.password) { REST_URL = "https://" + u.hostname; REST_TOKEN = decodeURIComponent(u.password); }
    else TCP = { host: u.hostname, port: +u.port || 6379, tls: u.protocol === "rediss:", user: decodeURIComponent(u.username || ""), pass: decodeURIComponent(u.password || "") };
  } catch {}
}
export const hasDb = () => !!((REST_URL && REST_TOKEN) || TCP);
export const dbInfo = () => ({ mode: REST_URL ? "rest" : TCP ? "tcp" : "none",
  keys: Object.keys(env).filter(k => /REDIS|KV_|UPSTASH/.test(k)).sort() });

/* minimális RESP-kliens a sima redis:// kapcsolathoz */
let sock = null, buf = Buffer.alloc(0), waiters = [];
function parse(b, i) {
  const t = String.fromCharCode(b[i]); const e = b.indexOf("\r\n", i); if (e < 0) return null;
  const line = b.toString("utf8", i + 1, e);
  if (t === "+") return [line, e + 2];
  if (t === "-") return [new Error(line), e + 2];
  if (t === ":") return [+line, e + 2];
  if (t === "$") { const n = +line; if (n < 0) return [null, e + 2]; if (b.length < e + 2 + n + 2) return null; return [b.toString("utf8", e + 2, e + 2 + n), e + 4 + n]; }
  if (t === "*") { const n = +line; if (n < 0) return [null, e + 2]; let j = e + 2; const out = []; for (let k = 0; k < n; k++) { const r = parse(b, j); if (!r) return null; out.push(r[0]); j = r[1]; } return [out, j]; }
  return [new Error("resp"), b.length];
}
function connect() {
  return new Promise((resolve, reject) => {
    const s = TCP.tls ? tls.connect({ host: TCP.host, port: TCP.port, servername: TCP.host }) : net.connect({ host: TCP.host, port: TCP.port });
    s.once(TCP.tls ? "secureConnect" : "connect", () => resolve(s));
    s.once("error", e => { reject(e); });
    s.on("data", d => { buf = Buffer.concat([buf, d]); let r; while (waiters.length && (r = parse(buf, 0))) { buf = buf.subarray(r[1]); const w = waiters.shift(); r[0] instanceof Error ? w.reject(r[0]) : w.resolve(r[0]); } });
    s.on("close", () => { sock = null; buf = Buffer.alloc(0); const ws = waiters; waiters = []; ws.forEach(w => w.reject(new Error("closed"))); });
    s.on("error", () => {});
  });
}
const enc = cmd => "*" + cmd.length + "\r\n" + cmd.map(a => { a = String(a); return "$" + Buffer.byteLength(a) + "\r\n" + a + "\r\n"; }).join("");
function sendRaw(s, cmd) { return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); s.write(enc(cmd)); }); }
async function tcpCmd(cmd) {
  if (!sock) {
    const s = await connect();
    if (TCP.pass) await sendRaw(s, TCP.user && TCP.user !== "default" ? ["AUTH", TCP.user, TCP.pass] : ["AUTH", TCP.pass]);
    sock = s;
  }
  return sendRaw(sock, cmd);
}

export async function redis(...cmd) {
  if (!REST_URL && TCP) { try { return await tcpCmd(cmd); } catch (e) { if (e.message === "closed") return tcpCmd(cmd); throw e; } }
  const r = await fetch(REST_URL, { method: "POST", headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

export const DEFAULT_SETTINGS = {
  clinicName: "Dr. Zsákai Zsolt", clinicSub: "Ortopéd Sebészeti Magánrendelés", prefix: "A",
  rooms: [{ id: 1, name: "Rendelő", doctor: "" }], showReception: false,
  showInitials: true, speech: true, gong: true, showQr: true, logo: ""
};

export function today() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // YYYY-MM-DD
}
let secretC = null, pinC = null;
async function secret() {
  if (secretC) return secretC;
  await redis("SET", "bh:secret", crypto.randomBytes(24).toString("hex"), "NX");
  return (secretC = await redis("GET", "bh:secret"));
}
export const qrToken = async day => crypto.createHmac("sha256", await secret()).update(day).digest("hex").slice(0, 12);
export async function getPin() {
  if (process.env.STAFF_PIN) return process.env.STAFF_PIN;
  if (pinC && Date.now() - pinC.at < 30000) return pinC.v;
  const v = (await redis("GET", "bh:pin")) || "";
  pinC = { v, at: Date.now() }; return v;
}
export async function setPin(p) { const ok = await redis("SET", "bh:pin", p, "NX"); pinC = null; return !!ok; }
export const rid = (n = 10) => crypto.randomBytes(n).toString("base64url").slice(0, n);

export async function isStaff(req) {
  const PIN = await getPin();
  const got = String(req.headers["x-pin"] || "");
  if (!PIN || got.length !== PIN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(PIN));
}

/* rövid memória-gyorsítótár: sok egyidejű lekérdezés egy Redis-hívással */
const cache = new Map();
export async function loadDay(day, fresh = false) {
  const c = cache.get(day);
  if (!fresh && c && Date.now() - c.at < 1200) return c.val;
  const raw = await redis("GET", "bh:d:" + day);
  const val = raw ? JSON.parse(raw) : { ver: 0, patients: [] };
  cache.set(day, { val, at: Date.now() });
  return val;
}
export async function saveDay(day, val) {
  val.ver = (val.ver || 0) + 1;
  await redis("SET", "bh:d:" + day, JSON.stringify(val), "EX", String(60 * 60 * 36)); // 36 óra után magától törlődik
  cache.set(day, { val, at: Date.now() });
  return val;
}
let sCache = null;
export async function loadSettings(fresh = false) {
  if (!fresh && sCache && Date.now() - sCache.at < 5000) return sCache.val;
  const raw = await redis("GET", "bh:settings");
  const stored = raw ? JSON.parse(raw) : {};
  if (Array.isArray(stored.rooms) && stored.rooms.length === 2 && stored.rooms[0].name === "1-es rendelő" && stored.rooms[1].name === "2-es rendelő" && !stored.rooms[0].doctor && !stored.rooms[1].doctor) delete stored.rooms; // régi alapérték
  if (stored.clinicName === "Magánrendelő") { delete stored.clinicName; delete stored.clinicSub; } // régi alapérték
  const val = Object.assign({}, DEFAULT_SETTINGS, stored);
  sCache = { val, at: Date.now() };
  return val;
}
export async function saveSettings(s) {
  const val = Object.assign({}, DEFAULT_SETTINGS, s);
  await redis("SET", "bh:settings", JSON.stringify(val));
  sCache = { val, at: Date.now() };
  return val;
}
export async function withLock(fn) {
  const me = rid(8);
  for (let i = 0; i < 40; i++) {
    const ok = await redis("SET", "bh:lock", me, "NX", "PX", "5000");
    if (ok) { try { return await fn(); } finally { const cur = await redis("GET", "bh:lock"); if (cur === me) await redis("DEL", "bh:lock"); } }
    await new Promise(r => setTimeout(r, 120 + Math.random() * 120));
  }
  throw new Error("busy");
}
export function newPatient(list, settings, { initials, room, src }) {
  const num = list.reduce((m, p) => Math.max(m, p.num || 0), 0) + 1;
  const prefix = String(settings.prefix || "A").toUpperCase().slice(0, 2);
  const roomOk = settings.rooms.some(r => r.id === room);
  return { id: rid(10), k: rid(16), num, code: prefix + "-" + String(num).padStart(3, "0"),
    initials: String(initials || "").toUpperCase().replace(/[^\p{L}. ]/gu, "").trim().slice(0, 6),
    room: roomOk ? room : 0, status: "waiting", createdAt: Date.now(), calledAt: 0, calledRoom: 0, calls: 0, src: src || "rec" };
}
export const strip = p => { const { k, ...rest } = p; return rest; };
export function send(res, code, obj) { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj)); }
export async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let d = ""; for await (const ch of req) d += ch; try { return JSON.parse(d || "{}"); } catch { return {}; }
}
