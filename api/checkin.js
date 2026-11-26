import { hasDb, today, loadDay, saveDay, loadSettings, withLock, newPatient, qrToken, redis, send, body } from "./_lib.js";
export default async function handler(req, res) {
  if (!hasDb()) return send(res, 503, { error: "nodb" });
  const day = today();
  if (req.method === "GET") {
    const s = await loadSettings();
    const valid = req.query?.t === await qrToken(day);
    return send(res, 200, { valid, clinicName: s.clinicName, clinicSub: s.clinicSub, logo: s.logo, rooms: s.rooms.map(r => ({ id: r.id, name: r.name, doctor: r.doctor })) });
  }
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const a = await body(req);
  if (a.t !== await qrToken(day)) return send(res, 403, { error: "token" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const n = await redis("INCR", "bh:rl:" + day + ":" + ip);
  if (n === 1) await redis("EXPIRE", "bh:rl:" + day + ":" + ip, "3600");
  if (n > 6) return send(res, 429, { error: "rate" });
  const settings = await loadSettings();
  let p;
  try {
    await withLock(async () => {
      const d = await loadDay(day, true);
      p = newPatient(d.patients, settings, { initials: a.initials, room: +a.room || 0, src: "qr" });
      d.patients.push(p); await saveDay(day, d);
    });
  } catch (e) { return send(res, 409, { error: "busy" }); }
  send(res, 200, { id: p.id, k: p.k, code: p.code, day });
}
