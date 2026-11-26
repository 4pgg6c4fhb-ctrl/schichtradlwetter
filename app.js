'use strict';
// Oberfläche. Rechnungen und Datenquellen stehen in core.js.

const $ = (id) => document.getElementById(id);

// ---------- Einstellungen ----------
const SETTINGS_VERSION = 2;
const DEFAULTS = {
  fixLat: '47.4894', fixLon: '12.0620', placeName: 'Wörgl',
  cycle: '1 1 2 2 3 3 f f f f', // Schichtsystem: Nummer = Schicht, f = frei
  t1: '6-14', t2: '14-22', t3: '22-6', t4: '',   // Zeiten der Schichten 1–4
  cycleStart: '2026-11-24',   // Tag 1 des Systems (erster Eintrag)
  freeOut: '5', freeBack: '16', // freie Tage: Hinfahrt / Rückfahrt (Uhr)
  heavyMm: '0.5',             // mehr als Tröpfeln
  snowCm: '1',
  rideKmh: '20',
  l1: '10', l1t: 'Handschuhe, Kappe, Fleece, Iso, Windjacke, Isohose',
  l2: '15', l2t: 'Fleece, Windjacke, lange Radhose',
  l3: '20', l3t: 'Fleece, lange Radhose',
  l4t: 'Alles kurz',
};
function settings() {
  const raw = load('settings', {});
  if ((raw.v || 1) < SETTINGS_VERSION) delete raw.heavyMm;   // alte Grenze (2 mm) durch neue ersetzen
  if (raw.l2t === 'Fleece, Windjacke, Radhose') raw.l2t = DEFAULTS.l2t;   // alter Standardtext
  return Object.assign({}, DEFAULTS, raw);
}
const num = (x, fb) => { const v = parseFloat(String(x).replace(',', '.')); return isNum(v) ? v : fb; };
function prefs(s) {
  return {
    heavyMm: num(s.heavyMm, 0.5), snowCm: num(s.snowCm, 1), rideKmh: num(s.rideKmh, 20),
    levels: [
      { below: num(s.l1, 10), text: s.l1t }, { below: num(s.l2, 15), text: s.l2t },
      { below: num(s.l3, 20), text: s.l3t }, { below: null, text: s.l4t },
    ],
  };
}

// ---------- Standort ----------
function getPosition() {
  const s = settings();
  const lat = num(s.fixLat, NaN), lon = num(s.fixLon, NaN);
  if (isNum(lat) && isNum(lon)) return Promise.resolve({ lat, lon, acc: 0, fixed: true });
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Kein GPS im Browser verfügbar'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, fixed: false }),
      (e) => {
        const last = load('lastPos');
        if (last) resolve(Object.assign(last, { stale: true }));
        else reject(new Error('Standort nicht freigegeben (' + e.message + ')'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5 * 60e3 }
    );
  });
}

// ---------- Schichtrad ----------
// Schichtsystem aus den Einstellungen, z. B. "1 1 2 2 3 3 f f f f" mit Zeiten "6-14", "14-22", "22-6".
const DAY = 86400e3;
const SNOW_BEFORE_H = 6;   // Hinfahrt: Neuschnee der letzten 6 Stunden zählt

// "6-14", "6:30 - 14:30", "22–6" → { s: 6, len: 8 }
function parseSpan(str) {
  const m = String(str || '').match(/(\d{1,2})(?:[:.](\d{2}))?\s*[-–bis ]+\s*(\d{1,2})(?:[:.](\d{2}))?/);
  if (!m) return null;
  const from = +m[1] + (+m[2] || 0) / 60, to = +m[3] + (+m[4] || 0) / 60;
  if (from > 24 || to > 24) return null;
  return { s: from, len: ((to - from + 24) % 24) || 24 };
}
// Anzeige-Art nach Beginnzeit
function shiftKind(start) {
  if (start >= 3 && start < 11) return { name: 'Früh', icon: 'sunrise', cls: 'early' };
  if (start >= 11 && start < 19) return { name: 'Spät', icon: 'sunset', cls: 'late' };
  return { name: 'Nacht', icon: 'moon', cls: 'night' };
}
let cycleCache = { key: '', list: [] };
function getCycle(s) {
  const key = [s.cycle, s.t1, s.t2, s.t3, s.t4].join('|');
  if (cycleCache.key === key) return cycleCache.list;
  const list = String(s.cycle || '').trim().split(/[\s,;]+/).filter(Boolean).map((tok) => {
    const n = parseInt(tok, 10);
    const span = n >= 1 && n <= 4 ? parseSpan(s['t' + n]) : null;
    return span ? Object.assign({ key: n }, shiftKind(span.s), span) : null;   // f, -, x … = frei
  });
  cycleCache = { key, list };
  return list;
}
function parseDate(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function shiftFor(date, s) {
  const cyc = getCycle(s);
  if (!cyc.length) return null;
  const diff = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - parseDate(s.cycleStart)) / DAY);
  return cyc[((diff % cyc.length) + cyc.length) % cyc.length];
}
// Wievielte gleiche Schicht in Folge (1., 2., …)
function shiftNumber(d, s) {
  const sh = shiftFor(d, s);
  let n = 1;
  for (let k = 1; k < 30; k++) {
    const p = shiftFor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - k), s);
    if (!p || p.key !== sh.key) break;
    n++;
  }
  return n;
}

// Alle Schichten (gestern bis +10 Tage) mit bewerteten Fahrten.
function planShifts(hours, data, s, p) {
  const byT = new Map(hours.map((h) => [h.t, h]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const now = Date.now();
  const items = [];
  const ride = (name, endT, snowFrom, snowTo) => {
    if (endT <= now) return null;
    // Wetterdaten sind stündlich: nächstliegende volle Stunde verwenden (z. B. 7:30 → Stunde bis 8:00)
    const key = Math.round(endT / HOUR) * HOUR;
    const h = byT.get(key) || byT.get(key + HOUR);
    const snow = snowRisk(snowFrom, snowTo, data, p.snowCm);
    const prev = [];
    for (let t = key - 6 * HOUR; t < key; t += HOUR) if (byT.has(t)) prev.push(byT.get(t));
    return { name, from: endT - HOUR, to: endT, h, a: h ? assessRide([h], snow, p, prev) : null };
  };
  const at = (d, hour) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(hour), Math.round((hour % 1) * 60)).getTime();
  for (let i = -1; i <= 10; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    let sh = shiftFor(d, s);
    let start, end, out, back;
    if (sh) {
      start = at(d, sh.s);
      end = start + sh.len * HOUR;
      out = start;                     // Hinfahrt: Stunde vor Schichtbeginn
      back = end + HOUR;               // Rückfahrt: Stunde nach Schichtende
    } else {
      if (i < 0) continue;
      // Freier Tag: Abfahrt um freeOut, Rückfahrt um freeBack (je 1 Stunde)
      const o = num(s.freeOut, 5), b = num(s.freeBack, 16);
      sh = { name: 'Frei', icon: 'calendar', cls: 'off', free: true, out: o, back: b };
      start = at(d, o); end = at(d, b);
      out = start + HOUR;
      back = end + HOUR;
    }
    if (back <= now) continue;
    items.push({
      d, sh, i, start, end,
      rides: [
        ride('Hinfahrt', out, out - HOUR - SNOW_BEFORE_H * HOUR, out),   // Neuschnee der 6 h vor Abfahrt
        ride('Rückfahrt', back, out - HOUR, back),   // Schnee seit der Hinfahrt zählt
      ].filter(Boolean),
    });
  }
  return items;
}

// ---------- Symbole (Linien-Icons, 24×24) ----------
const ICONS = {
  bike: '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  stop: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  sunrise: '<path d="M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M8 6l4-4 4 4M16 18a4 4 0 0 0-8 0"/>',
  sunset: '<path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  work: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
  thermo: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  drop: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7Z"/>',
  snow: '<path d="M2 12h20M12 2v20M5 5l14 14M19 5 5 19"/>',
  humid: '<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05Z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/>',
  shirt: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23Z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- Darstellung ----------
const wdFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'short' });
const shortDayFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'short', day: 'numeric', month: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });
const hr = (t) => { const d = new Date(t); return d.getMinutes() ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : String(d.getHours()); };
const VERDICT = { ok: 'Fahren', warn: 'Aufpassen', stop: 'Nicht fahren' };
const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const deg = (x) => (isNum(x) ? `${fmt0(x)}°` : '–');
const pct = (x) => (isNum(x) ? `${fmt0(x)} %` : '–');
const dayLabel = (i, d) => (i === 0 ? 'Heute' : i === 1 ? 'Morgen' : i === -1 ? 'Gestern' : shortDayFmt.format(d));
const pill = (v) => `<span class="pill ${v}">${icon(v)}${VERDICT[v]}</span>`;
const worstOf = (rides) => {
  const v = rides.map((r) => r.a?.verdict).filter(Boolean);
  return v.includes('stop') ? 'stop' : v.includes('warn') ? 'warn' : v.length ? 'ok' : null;
};
// "Handschuhe, Kappe + Regenjacke" → Chips
function chips(text) {
  const [base, ...extra] = String(text).split(' + ');
  return `<div class="chips">${base.split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}` +
    `${extra.map((x) => `<span class="chip extra">+ ${esc(x)}</span>`).join('')}</div>`;
}

// Kopf eines Tages: Schicht-Abzeichen
function shiftBadge(it) {
  const title = it.sh.free
    ? 'Frei'
    : `${it.sh.name}schicht <small>${fmtH(it.sh.s)}–${fmtH((it.sh.s + it.sh.len) % 24)} Uhr</small>`;
  return `<span class="badge ${it.sh.cls}"><span class="dot">${icon(it.sh.icon)}</span>${title}</span>`;
}

// Aktuelle Schicht: Hin- und Rückfahrt mit Status, Werten und Kleidung.
function renderCurrent(items) {
  const el = $('next');
  const it = items.find((x) => x.rides.length);
  if (!it) { el.hidden = true; return null; }
  const worst = worstOf(it.rides) || 'ok';
  el.className = `card next ${worst}`;
  el.hidden = false;
  const trend = it.rides.some((r) => r.a?.trend);
  const rideBlock = (r) => {
    const head = `<div class="cur-name">${icon(r.name === 'Hinfahrt' ? (it.sh.free ? 'bike' : 'work') : 'home')}${r.name} ${hr(r.from)}–${hr(r.to)} Uhr</div>`;
    if (!r.a) return `<div class="cur-ride">${head}<div class="hint">noch keine Vorhersage</div></div>`;
    const a = r.a;
    return `<div class="cur-ride">
      <div class="status-line">
        <div class="status-icon ${a.verdict}">${icon(a.verdict)}</div>
        <div class="status-text">${head}<b>${VERDICT[a.verdict]}</b>${a.reasons.length ? `<span>${esc(a.reasons.join(' · '))}</span>` : ''}</div>
      </div>
      <div class="metrics four num">
        <div class="metric"><div class="v">${deg(r.h.feel)}</div><div class="l">${icon('bike')}Gefühlt</div></div>
        <div class="metric"><div class="v">${pct(r.h.prob)}</div><div class="l">${icon('drop')}Regen</div></div>
        <div class="metric"><div class="v">${pct(a.pSnow)}</div><div class="l">${icon('snow')}Schnee</div></div>
        <div class="metric"><div class="v">${pct(r.h.rh)}</div><div class="l">${icon('humid')}Feuchte</div></div>
      </div>
      <div class="overline">Kleidung</div>
      ${chips(a.clothes)}</div>`;
  };
  const past = it.rides.length === 1 && it.rides[0].name === 'Rückfahrt' ? '<div class="hint">Hinfahrt bereits vorbei</div>' : '';
  el.innerHTML = `
    <div class="head"><span class="overline">Aktuelle Schicht · ${dayLabel(it.i, it.d)}</span>${trend ? '<span class="tag">Trend</span>' : ''}</div>
    <div class="cur-badge">${shiftBadge(it)}</div>
    ${past}${it.rides.map(rideBlock).join('')}`;
  return it;
}

function renderSummary(items, s) {
  const notes = { stop: [], warn: [], none: 0 };
  for (const it of items) {
    if (!it.rides.length) continue;
    if (it.rides.some((r) => !r.a)) { notes.none++; if (!it.rides.some((r) => r.a)) continue; }
    const who = it.sh.free ? `${dayLabel(it.i, it.d)} · frei` : `${dayLabel(it.i, it.d)} · ${shiftNumber(it.d, s)}. ${it.sh.name}schicht`;
    const where = (pred) => {
      const n = it.rides.filter((r) => r.a && pred(r.a)).map((r) => r.name);
      return n.length === 2 ? 'Hin- und Rückfahrt' : n[0];
    };
    const unsure = it.rides.some((r) => r.a?.trend) ? ' (noch unsicher)' : '';
    const bad = (k) => it.rides.some((r) => r.a && k(r.a));
    if (bad((a) => a.pSnow >= 50)) notes.stop.push([who, `${where((a) => a.pSnow >= 50)}: Schneefahrbahn – mit dem Rad wird's nichts${unsure}.`]);
    else if (bad((a) => a.pHeavy >= 50)) notes.stop.push([who, `${where((a) => a.pHeavy >= 50)}: viel Regen – besser nicht mit dem Rad${unsure}.`]);
    const stopped = bad((a) => a.pSnow >= 50) || bad((a) => a.pHeavy >= 50);
    const issues = (a) => [
      !stopped && a.pSnow >= 25 ? 'evtl. Schnee auf der Fahrbahn' : null,
      !stopped && a.pHeavy >= 25 ? 'evtl. stärkerer Regen' : null,
      a.ice ? (a.iceText.startsWith('Reif') ? 'Reifglätte möglich' : 'Glätte durch Nässe') : null,
      a.storm ? 'Sturmböen' : null,
    ].filter(Boolean).join(' und ');
    const per = it.rides.filter((r) => r.a && issues(r.a)).map((r) => [r.name, issues(r.a)]);
    let w = per.map(([n, t]) => `${n}: ${t}`);
    if (per.length === 2 && per[0][1] === per[1][1]) w = [`Hin- und Rückfahrt: ${per[0][1]}`];
    if (w.length) notes.warn.push([who, `${w.join(' · ')}${unsure}.`]);
  }
  const head = notes.stop.length
    ? `<div class="verdict-line stop">${icon('stop')}<span>${notes.stop.length === 1 ? 'Ein Tag' : notes.stop.length + ' Tage'} besser nicht mit dem Rad</span></div>`
    : `<div class="verdict-line ok">${icon('ok')}<span>Fahrten im ganzen Schichtrad möglich${notes.warn.length ? '' : ' – kein Schnee und kein Starkregen in Sicht'}</span></div>`;
  const li = (cls, [who, text]) => `<li class="${cls}"><span class="when">${esc(who)}</span> – ${esc(text)}</li>`;
  const list = [...notes.stop.map((n) => li('stop', n)), ...notes.warn.map((n) => li('warn', n))];
  if (notes.none) list.push(`<li class="info">Für ${notes.none === 1 ? 'einen Tag' : notes.none + ' Tage'} gibt es noch keine Vorhersage.</li>`);
  $('shiftSummary').innerHTML = head + (list.length ? `<ul class="notes">${list.join('')}</ul>` : '');
}

// Ein Fahrt-Block in der Liste: nur ob es geht und welche Gefahren es gibt.
function rideHtml(r, free = false) {
  const name = `<span class="ride-name">${icon(r.name === 'Hinfahrt' ? (free ? 'bike' : 'work') : 'home')}${r.name} ${hr(r.from)}–${hr(r.to)} Uhr</span>`;
  if (!r.a) return `<div class="ride none"><div class="ride-row">${name}<span class="hint">keine Vorhersage</span></div></div>`;
  const a = r.a;
  return `<div class="ride ${a.verdict}">
    <div class="ride-row">${name}${pill(a.verdict)}</div>
    ${a.reasons.length ? `<div class="ride-why">${esc(a.reasons.join(' · '))}</div>` : ''}</div>`;
}
// Beide Fahrten ohne Gefahr → eine Zeile.
function ridesHtml(rides, free) {
  const [h, r] = rides;
  if (rides.length === 2 && h.a?.verdict === 'ok' && r.a?.verdict === 'ok') {
    return `<div class="ride ok"><div class="ride-row"><span class="ride-name">${icon('bike')}Hin- und Rückfahrt</span>${pill('ok')}</div></div>`;
  }
  return rides.map((x) => rideHtml(x, free)).join('');
}

function renderShifts(items, current) {
  $('shifts').innerHTML = items.filter((it) => it !== current).map((it) => {
    const trend = it.rides.some((r) => r.a?.trend);
    return `<div class="shift">
      <div class="date${it.i === 0 ? ' today' : ''}"><div class="wd">${it.i === 0 ? 'Heute' : wdFmt.format(it.d)}</div><div class="d">${it.d.getDate()}</div></div>
      <div>
        <div class="shift-title">${shiftBadge(it)}${trend ? '<span class="tag">Trend</span>' : ''}</div>
        ${ridesHtml(it.rides, it.sh.free)}
      </div></div>`;
  }).join('');
}
const fmtH = (h) => (h % 1 ? `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}` : String(h));

function setStatus(parts) { $('status').innerHTML = parts.filter(Boolean).join('<br>'); }

// Kopf-Symbole
$('logo').innerHTML = icon('bike');
$('btnReload').innerHTML = icon('refresh');
$('btnSettings').innerHTML = icon('sliders');
$('howSummary').insertAdjacentHTML('afterbegin', icon('info'));

// Teilen: Handy → Teilen-Menü, sonst Link kopieren
const APP_URL = 'https://4pgg6c4fhb-ctrl.github.io/schichtradlwetter/';
const shareLabel = () => { $('btnShare').innerHTML = `${icon('share')}App teilen`; };
shareLabel();
$('btnShare').addEventListener('click', async () => {
  const data = { title: 'SchichtRADWETTER', text: 'Radwetter für Hin- und Rückfahrt, passend zum Schichtplan:', url: APP_URL };
  try {
    if (navigator.share) { await navigator.share(data); return; }
    await navigator.clipboard.writeText(APP_URL);
    $('btnShare').textContent = 'Link kopiert ✓';
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    prompt('Link zum Kopieren:', APP_URL);
  }
  setTimeout(shareLabel, 2500);
});

// ---------- Hauptablauf ----------
let busy = false;
async function run() {
  if (busy) return;
  busy = true;
  $('btnReload').classList.add('spin');
  const s = settings();
  const p = prefs(s);
  try {
    setStatus(['Standort wird ermittelt …']);
    const pos = await getPosition();
    if (!pos.fixed && !pos.stale) store('lastPos', { lat: pos.lat, lon: pos.lon, acc: pos.acc });

    setStatus(['Lade Wetter …']);
    const [gs, om, ecm] = await Promise.all([
      fetchGeoSphere(pos.lat, pos.lon), fetchOpenMeteo(pos.lat, pos.lon), fetchEcmwf(pos.lat, pos.lon)]);
    const hours = buildHours(pos, gs, om, ecm, { heavyMm: p.heavyMm, rideKmh: p.rideKmh, hours: 24 * 12 });
    if (!hours.length) throw new Error('Keine Vorhersagedaten für diesen Ort.');

    const h0 = hours[0];
    $('place').innerHTML = `${icon('pin')}${esc(s.placeName || (pos.fixed ? 'Fester Standort' : 'GPS-Standort'))}` +
      (isNum(h0?.temp) ? ` · jetzt ${deg(h0.temp)}, gefühlt ${deg(h0.feel)}` : '') + (pos.stale ? ' · letzter Standort' : '');

    const items = planShifts(hours, { gs, om, ecm }, s, p);
    const current = renderCurrent(items);
    renderSummary(items, s);
    renderShifts(items, current);

    const names = { nwp: 'GeoSphere', ens: 'GeoSphere-Ensemble', now: 'Radar' };
    const ok = Object.keys(gs.res).map((k) => names[k]);
    if (om.rows) ok.push('ICON-D2');
    if (ecm.rows) ok.push('ECMWF');
    const msgs = [`Stand ${timeFmt.format(new Date())} · ${ok.join(', ') || 'keine Quellen'}`];
    for (const [k, e] of Object.entries(gs.errors)) msgs.push(`<span class="warn">${names[k]}: ${e}</span>`);
    if (om.error) msgs.push(`<span class="warn">ICON-D2: ${om.error}</span>`);
    if (ecm.error) msgs.push(`<span class="warn">ECMWF: ${ecm.error}</span>`);
    setStatus(msgs);
  } catch (e) {
    setStatus([`<span class="err">${esc(e.message)}</span>`]);
  } finally {
    $('btnReload').classList.remove('spin');
    busy = false;
  }
}

// ---------- Einstellungs-Dialog ----------
const FIELDS = Object.keys(DEFAULTS);
function fillForm(s) { FIELDS.forEach((f) => { $(f).value = s[f]; }); }
$('btnSettings').addEventListener('click', () => { fillForm(settings()); $('settings').showModal(); });
$('btnDefaults').addEventListener('click', () => fillForm(DEFAULTS));
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const next = { v: SETTINGS_VERSION };
  FIELDS.forEach((f) => { next[f] = $(f).value.trim(); });
  store('settings', next);
  run();
});
$('btnReload').addEventListener('click', () => {
  try { Object.keys(localStorage).filter((k) => /^(gs-|om)/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
  run();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });

// alte Zwischenspeicher (ohne Schneedaten) entfernen
try { Object.keys(localStorage).filter((k) => /^(om-|om2-|gs-nwp-)/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch (_) {}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
run();
