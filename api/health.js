import { hasDb, dbInfo, redis, send, dbHost } from "./_lib.js";
export default async function handler(req, res) {
  const info = dbInfo(); let ping = null, ms = [];
  if (hasDb()) { try { ping = await redis("PING"); for (let i = 0; i < 3; i++) { const t = Date.now(); await redis("PING"); ms.push(Date.now() - t); } } catch (e) { ping = "hiba: " + e.message; } }
  const best = ms.length ? Math.min(...ms) : null;
  const region = best == null ? null : best < 15 ? "valószínűleg EU (Frankfurt közelében)" : best < 40 ? "valószínűleg Európa" : "valószínűleg Európán kívül (pl. USA)";
  send(res, 200, { ok: hasDb() && ping === "PONG", ...info, ping, dbHost: dbHost(), pingMs: best, functionRegion: process.env.VERCEL_REGION || null, dbRegionGuess: region });
}
