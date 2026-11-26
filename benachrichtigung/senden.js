'use strict';
// Schickt vor Schichtbeginn eine Push-Nachricht (ntfy) mit der Radkleidung für die nächsten Stunden.
// Läuft per GitHub Actions alle 30 min. Lokal testen:
//   TROCKEN=1 JETZT="2026-11-27T05:10" node benachrichtigung/senden.js
// Umgebungsvariablen: NTFY_TOPIC (Pflicht außer bei TROCKEN), NTFY_SERVER (Standard https://ntfy.sh),
//   TROCKEN=1 (nur ausgeben), TEST=1 (sofort senden, ohne Schicht), JETZT (Ortszeit, nur zum Testen).

const fs = require('fs');
const path = require('path');
const core = require('../core.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'schichten.json'), 'utf8'));
const TZ = cfg.zeitzone || 'Europe/Vienna';
const SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const TOPIC = process.env.NTFY_TOPIC || '';
const DRY = !!process.env.TROCKEN;
const TEST = !!process.env.TEST;
const H = core.HOUR;
const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// ---- Zeitzonen-Helfer (ohne Bibliotheken) ----
function parts(ts) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ts)).forEach(({ type, value }) => { p[type] = value; });
  return p;
}
function offset(ts) {
  const p = parts(ts);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
// "2026-11-27", "06:00" (Ortszeit) → UTC-Millisekunden
function localToUtc(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offset(guess);
  ts = guess - offset(ts);            // Korrektur an Sommer-/Winterzeit-Grenzen
  return ts;
}
const localDate = (ts) => { const p = parts(ts); return `${p.year}-${p.month}-${p.day}`; };
const localTime = (ts) => { const p = parts(ts); return `${p.hour}:${p.minute}`; };
const weekdayDe = (date) => DAYS[new Date(date + 'T12:00:00Z').getUTCDay()];

// ---- Schichten in den nächsten ~2 Tagen ----
function shiftsAround(now) {
  const out = new Set();
  const frei = new Set(cfg.frei || []);
  for (const dayTs of [now - 86400e3, now, now + 86400e3]) {
    const date = localDate(dayTs);
    if (frei.has(date)) continue;
    let times = (cfg.wochenplan || {})[weekdayDe(date)];
    if (!times) continue;
    if (!Array.isArray(times)) times = [times];
    times.forEach((t) => out.add(localToUtc(date, t)));
  }
  for (const e of cfg.einzeltermine || []) {
    const [d, t] = e.trim().split(/[ T]+/);
    if (d && t && !frei.has(d + ' ' + t)) out.add(localToUtc(d, t));
  }
  return [...out].sort((a, b) => a - b);
}

// ---- ntfy ----
async function alreadySent(id) {
  const r = await fetch(`${SERVER}/${encodeURIComponent(TOPIC)}/json?poll=1&since=24h`);
  if (!r.ok) throw new Error(`ntfy Abfrage HTTP ${r.status}`);
  return (await r.text()).split('\n').filter(Boolean).some((line) => {
    try { return (JSON.parse(line).tags || []).includes(id); } catch (_) { return false; }
  });
}
async function send(msg) {
  const r = await fetch(SERVER, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ topic: TOPIC }, msg)) });
  if (!r.ok) throw new Error(`ntfy Senden HTTP ${r.status}: ${await r.text()}`);
}

// ---- Nachricht bauen ----
function describe(h) {
  if (!h) return '–';
  return `${core.fmt0(h.temp)}°, Regen ${core.fmt0(h.prob)} %`;
}
async function buildMessage(start, now) {
  const { lat, lon, name } = cfg.ort;
  const pos = { lat, lon };
  const [gs, om] = await Promise.all([core.fetchGeoSphere(lat, lon), core.fetchOpenMeteo(lat, lon)]);
  const stunden = cfg.stunden || 12;
  // Stunde vor Schichtbeginn (Hinweg) bis Ende des Zeitraums
  const hours = core.buildHours(pos, gs, om).filter((h) => h.t > start - H && h.t <= start + stunden * H);
  const c = core.clothing(hours);
  if (!c) throw new Error('Keine Wetterdaten bekommen: ' + JSON.stringify(Object.assign({}, gs.errors, { om: om.error })));
  const first = hours[0], last = hours[hours.length - 1];
  const lines = [
    ...c.warnings,
    ...c.items.map(([i, t]) => `${i} ${t}`),
    '',
    c.summary,
    `Hinweg ${localTime(start)}: ${describe(first)} · nach ${stunden} h (${localTime(start + stunden * H)}): ${describe(last)}`,
    `📍 ${name || ''} · Quellen: ${[...Object.keys(gs.res).map((k) => ({ ens: 'GeoSphere-Ensemble', nwp: 'GeoSphere', now: 'Radar' })[k]), om.rows ? 'ICON-D2' : null].filter(Boolean).join(', ')}`,
  ];
  return { title: `🚲 Schicht ${localTime(start)} – Radkleidung`, message: lines.join('\n'), priority: c.warnings.length ? 4 : 3 };
}

async function main() {
  if (!TOPIC && !DRY) throw new Error('NTFY_TOPIC fehlt (als Repository-Secret anlegen)');
  const now = process.env.JETZT ? localToUtc(...process.env.JETZT.split(/[ T]/)) : Date.now();
  const lead = (cfg.vorlaufMinuten ?? 60) * 60e3;

  let due = shiftsAround(now).filter((s) => now >= s - lead && now < s);
  if (TEST && !due.length) due = [Math.ceil(now / H) * H];
  if (!due.length) { console.log(`Keine Schicht fällig (${localDate(now)} ${localTime(now)} ${TZ}).`); return; }

  for (const start of due) {
    const id = 'schicht-' + localDate(start).replace(/-/g, '') + '-' + localTime(start).replace(':', '');
    if (!DRY && !TEST && await alreadySent(id)) { console.log(`${id}: schon gesendet.`); continue; }
    const msg = await buildMessage(start, now);
    msg.tags = [id];
    console.log(`--- ${id}\n${msg.title}\n${msg.message}\n`);
    if (!DRY) { await send(msg); console.log('gesendet.'); }
  }
}

main().catch((e) => { console.error('Fehler:', e.message); process.exit(1); });
