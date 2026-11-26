import crypto from "node:crypto";

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const hasDb = () => !!(URL_ && TOKEN);

export async function redis(...cmd) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

export const DEFAULT_SETTINGS = {
  clinicName: "Magánrendelő", prefix: "A",
  rooms: [{ id: 1, name: "1-es rendelő", doctor: "" }, { id: 2, name: "2-es rendelő", doctor: "" }],
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
  const val = Object.assign({}, DEFAULT_SETTINGS, raw ? JSON.parse(raw) : {});
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
