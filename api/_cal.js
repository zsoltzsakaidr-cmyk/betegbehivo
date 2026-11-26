import { redis, loadDay, saveDay, loadSettings, withLock, rid } from "./_lib.js";

/* Google Naptár (titkos iCal-cím) → napi időpontok. Csak időpontot és monogramot tárolunk. */
function unfold(txt) { return txt.replace(/\r?\n[ \t]/g, ""); }
function budapestParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(d).map(p => [p.type, p.value]));
  return { day: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` };
}
function parseDt(prop, val) {
  if (/VALUE=DATE(?!-)/.test(prop) || /^\d{8}$/.test(val)) return null; // egész napos
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/); if (!m) return null;
  const [, Y, Mo, D, h, mi, s, z] = m;
  if (z) { const d = new Date(Date.UTC(+Y, Mo - 1, +D, +h, +mi, +s)); return { ...budapestParts(d), at: d.getTime() }; }
  // helyi (TZID=Europe/Budapest vagy lebegő) idő
  const guess = new Date(Date.UTC(+Y, Mo - 1, +D, +h, +mi, +s));
  const off = (() => { const p = budapestParts(guess); const [hh, mm] = p.time.split(":"); return ((+hh - +h) * 60 + (+mm - +mi)) * 60000; })();
  const at = guess.getTime() - (((off % 86400000) + 86400000 + 43200000) % 86400000 - 43200000);
  return { day: `${Y}-${Mo}-${D}`, time: `${h}:${mi}`, at };
}
export function nameOf(summary) {
  const segs = String(summary || "").split(/\s[-–—]\s/);
  return (segs.length > 1 ? segs[segs.length - 1] : segs[0]).split(/,|\(|\//)[0].replace(/\s+/g, " ").trim().slice(0, 60);
}
export function initialsOf(summary) {
  const segs = String(summary || "").split(/\s[-–—]\s/);
  let name = (segs.length > 1 ? segs[segs.length - 1] : segs[0]).split(/,|\(|\//)[0];
  name = name.replace(/\b(dr|prof|ifj|id|özv)\.?\s*/gi, " ").trim();
  const parts = name.split(/\s+/).filter(w => /^\p{L}/u.test(w)).slice(0, 3);
  return parts.map(w => w[0].toUpperCase() + ".").join(" ").slice(0, 8);
}
export function eventsForDay(ics, day, from = "16:00", to = "20:00") {
  const out = [];
  for (const blk of unfold(ics).split("BEGIN:VEVENT").slice(1)) {
    const body = blk.split("END:VEVENT")[0];
    const get = k => { const m = body.match(new RegExp("^" + k + "([;:][^\\n]*)$", "m")); if (!m) return null; const line = m[1]; const i = line.indexOf(":"); return { prop: line.slice(0, i), val: line.slice(i + 1).trim() }; };
    if (/^STATUS:CANCELLED/m.test(body) || /^RRULE/m.test(body)) continue;
    const ds = get("DTSTART"); if (!ds) continue;
    const st = parseDt(ds.prop, ds.val); if (!st || st.day !== day) continue;
    const uid = (get("UID") || {}).val || "";
    const rec = (get("RECURRENCE-ID") || {}).val || "";
    const sum = ((get("SUMMARY") || {}).val || "").replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ");
    if (/szabads|távol|pihen/i.test(sum)) continue;
    if (!/\s[-–—]\s/.test(sum)) continue;               // csak „Vizsgálat – Név” formájú bejegyzés
    if (st.time < from || st.time > to) continue;      // csak rendelési időben
    out.push({ uid: (uid + rec).slice(0, 200), time: st.time, at: st.at, initials: initialsOf(sum), name: nameOf(sum) });
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function maybeSync(day, force = false) {
  const s = await loadSettings();
  if (!s.icalUrl) return { ok: false, reason: "nourl" };
  if (!force) { const ok = await redis("SET", "bh:sync:" + day, "1", "NX", "EX", "60"); if (!ok) return { ok: true, skipped: true }; }
  let ics;
  try { const r = await fetch(s.icalUrl, { headers: { "User-Agent": "betegbehivo" } }); if (!r.ok) throw new Error("http " + r.status); ics = await r.text(); }
  catch (e) { await redis("SET", "bh:syncerr", e.message, "EX", "3600"); return { ok: false, reason: "fetch" }; }
  const evs = eventsForDay(ics, day, s.hoursFrom || "16:00", s.hoursTo || "20:00");
  await withLock(async () => {
    const d = await loadDay(day, true); const L = d.patients; let changed = false;
    const byUid = new Map(L.filter(p => p.calUid).map(p => [p.calUid, p]));
    const seen = new Set();
    for (const e of evs) {
      seen.add(e.uid);
      const p = byUid.get(e.uid);
      if (p) { if (p.apptAt !== e.at || p.initials !== e.initials || p.name !== e.name) { p.apptAt = e.at; p.time = e.time; if (p.status === "waiting") { p.initials = e.initials; p.name = e.name; } changed = true; } continue; }
      const num = L.reduce((m, x) => Math.max(m, x.num || 0), 0) + 1;
      const prefix = String(s.prefix || "A").toUpperCase().slice(0, 2);
      L.push({ id: rid(10), k: rid(16), num, code: prefix + "-" + String(num).padStart(3, "0"), initials: e.initials, name: e.name, room: 0, status: "waiting",
        createdAt: Date.now(), apptAt: e.at, time: e.time, calUid: e.uid, arrived: false, calledAt: 0, calledRoom: 0, calls: 0, src: "cal" });
      changed = true;
    }
    for (let i = L.length - 1; i >= 0; i--) { const p = L[i]; if (p.calUid && !seen.has(p.calUid) && p.status === "waiting" && !p.arrived) { L.splice(i, 1); changed = true; } }
    if (changed) await saveDay(day, d);
  });
  await redis("DEL", "bh:syncerr");
  return { ok: true, count: evs.length };
}
