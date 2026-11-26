import { hasDb, dbInfo, redis, send } from "./_lib.js";
export default async function handler(req, res) {
  const info = dbInfo(); let ping = null;
  if (hasDb()) { try { ping = await redis("PING"); } catch (e) { ping = "hiba: " + e.message; } }
  send(res, 200, { ok: hasDb() && ping === "PONG", ...info, ping });
}
