import { hasDb, isStaff, getPin, today, loadDay, saveDay, loadSettings, saveSettings, withLock, newPatient, qrToken, strip, send, body } from "./_lib.js";
const byNum = (a, b) => a.num - b.num;
const waitingFor = (list, roomId) => list.filter(p => p.status === "waiting" && (!p.room || p.room === roomId)).sort(byNum);
const calledIn = (list, roomId) => list.filter(p => p.status === "called" && p.calledRoom === roomId).sort((a, b) => b.calledAt - a.calledAt)[0];

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (!hasDb()) return send(res, 503, { error: "nodb" });
  if (!(await isStaff(req))) return send(res, 401, { error: (await getPin()) ? "pin" : "setup" });
  const a = await body(req);
  const day = today();
  let result = null;
  try {
    if (a.type === "settings") {
      const s = a.settings || {};
      if (typeof s.logo === "string" && s.logo.length > 400000) return send(res, 400, { error: "logo" });
      await saveSettings(s);
    } else {
      await withLock(async () => {
        const d = await loadDay(day, true);
        const settings = await loadSettings();
        const L = d.patients, now = Date.now();
        const find = id => L.find(p => p.id === id);
        if (a.type === "issue") {
          const p = newPatient(L, settings, { initials: a.initials, room: +a.room || 0, src: "rec" });
          L.push(p); result = strip(p);
        } else if (a.type === "next" || a.type === "skip") {
          const room = +a.room;
          const cur = calledIn(L, room);
          if (cur) { cur.status = a.type === "skip" ? "missed" : "done"; cur.doneAt = now; }
          const nx = waitingFor(L, room)[0];
          if (nx) { nx.status = "called"; nx.calledRoom = room; nx.calledAt = now; nx.calls = 1; result = strip(nx); }
        } else if (a.type === "recall") {
          const p = find(a.id); if (p && p.status === "called") { p.calledAt = now; p.calls = (p.calls || 1) + 1; result = strip(p); }
        } else if (a.type === "call") {
          const room = +a.room, p = find(a.id);
          if (p) { const cur = calledIn(L, room); if (cur && cur !== p) { cur.status = "done"; cur.doneAt = now; }
            p.status = "called"; p.calledRoom = room; p.calledAt = now; p.calls = (p.calls || 0) + 1; result = strip(p); }
        } else if (a.type === "back") {
          const p = find(a.id); if (p) { p.status = "waiting"; p.calledRoom = 0; }
        } else if (a.type === "delete") {
          const i = L.findIndex(p => p.id === a.id); if (i >= 0) L.splice(i, 1);
        } else throw new Error("unknown");
        await saveDay(day, d);
      });
    }
  } catch (e) { return send(res, e.message === "busy" ? 409 : 400, { error: e.message }); }
  const [d, settings] = await Promise.all([loadDay(day), loadSettings()]);
  send(res, 200, { result, state: { day, ver: d.ver, patients: d.patients.map(strip), settings, qrToken: await qrToken(day), now: Date.now() } });
}
