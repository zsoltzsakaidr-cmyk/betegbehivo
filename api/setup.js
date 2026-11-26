import { hasDb, getPin, setPin, send, body } from "./_lib.js";
export default async function handler(req, res) {
  if (!hasDb()) return send(res, 503, { error: "nodb" });
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (await getPin()) return send(res, 409, { error: "exists" });
  const { pin } = await body(req);
  if (!/^\d{4,8}$/.test(String(pin || ""))) return send(res, 400, { error: "format" });
  const ok = await setPin(String(pin));
  send(res, ok ? 200 : 409, { ok });
}
