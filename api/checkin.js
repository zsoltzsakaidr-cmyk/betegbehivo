import { freeSlots, claimSlot, hasDb, today, loadDay, saveDay, loadSettings, withLock, newPatient, qrToken, redis, send, body, rid } from "./_lib.js";
import { maybeSync } from "./_cal.js";
export default async function handler(req, res) {
  if (!hasDb()) return send(res, 503, { error: "nodb" });
  const day = today();
  if (req.method === "GET") {
    const s = await loadSettings();
    const valid = req.query?.t === await qrToken(day);
    let appointments = [];
    if (valid) {
      if (!s.icalUrl) appointments = freeSlots(await loadDay(day), s, day).map(t => ({ id: "slot:" + t, time: t }));
      else { try { await maybeSync(day); } catch {}
      const d = await loadDay(day);
      appointments = d.patients.filter(p => p.src === "cal" && p.status === "waiting" && !p.phone) // a tableten megérkezett is választható, hogy a telefonon kövesse
        .sort((a, b) => a.apptAt - b.apptAt).map(p => ({ id: p.id, time: p.time })); }
    }
    return send(res, 200, { valid, clinicName: s.clinicName, clinicSub: s.clinicSub, logo: s.logo, appointments,
      rooms: s.rooms.map(r => ({ id: r.id, name: r.name, doctor: r.doctor })) });
  }
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const a = await body(req);
  if (a.t !== await qrToken(day)) return send(res, 403, { error: "token" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const n = await redis("INCR", "bh:rl:" + day + ":" + ip);
  if (n === 1) await redis("EXPIRE", "bh:rl:" + day + ":" + ip, "3600");
  if (n > 8) return send(res, 429, { error: "rate" });
  const settings = await loadSettings();
  let p, err = null;
  try {
    await withLock(async () => {
      const d = await loadDay(day, true);
      if (typeof a.claim === "string" && a.claim.startsWith("slot:")) {
        if (settings.icalUrl) { err = "gone"; return; }
        const r = claimSlot(d, settings, day, a.claim.slice(5), true);
        if (r.err) { err = r.err; return; } p = r.p;
      } else if (a.claim) {
        p = d.patients.find(x => x.id === a.claim && x.src === "cal");
        if (!p || p.status !== "waiting") { err = "gone"; return; }
        if (p.phone) { err = "taken"; return; }
        if (!p.arrived) { p.arrived = true; p.arrivedAt = Date.now(); }
        p.phone = true; p.k = rid(16);
      } else {
        p = newPatient(d.patients, settings, { initials: "", room: +a.room || 0, src: "qr" });
        d.patients.push(p);
      }
      await saveDay(day, d);
    });
  } catch (e) { return send(res, 409, { error: "busy" }); }
  if (err) return send(res, 409, { error: err });
  send(res, 200, { id: p.id, k: p.k, code: p.code, day });
}
