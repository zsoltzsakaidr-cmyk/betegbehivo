import { hasDb, isStaff, getPin, today, loadDay, loadSettings, qrToken, strip, send } from "./_lib.js";
export default async function handler(req, res) {
  if (!hasDb()) return send(res, 503, { error: "nodb" });
  if (!(await isStaff(req))) return send(res, 401, { error: (await getPin()) ? "pin" : "setup" });
  const day = today();
  const [d, settings] = await Promise.all([loadDay(day), loadSettings()]);
  send(res, 200, { day, ver: d.ver, patients: d.patients.map(strip), settings, qrToken: await qrToken(day), now: Date.now() });
}
