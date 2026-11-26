import { hasDb, today, loadDay, loadSettings, send } from "./_lib.js";
export default async function handler(req, res) {
  if (!hasDb()) return send(res, 503, { error: "nodb" });
  const { id, k } = req.query || {};
  const day = today();
  const [d, s] = await Promise.all([loadDay(day), loadSettings()]);
  const p = d.patients.find(x => x.id === id && x.k === k);
  if (!p) return send(res, 404, { error: "gone" });
  const elig = x => x.status === "waiting" && x.num < p.num && (!p.room || !x.room || x.room === p.room);
  const room = s.rooms.find(r => r.id === (p.calledRoom || p.room));
  send(res, 200, { code: p.code, status: p.status, ahead: p.status === "waiting" ? d.patients.filter(elig).length : 0,
    roomName: room ? room.name : "", doctor: room ? room.doctor : "", calledAt: p.calledAt, calls: p.calls, clinicName: s.clinicName });
}
