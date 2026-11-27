'use strict';
// Oberfläche. Rechnungen und Datenquellen stehen in core.js.

const $ = (id) => document.getElementById(id);

// ---------- Einstellungen ----------
const SETTINGS_VERSION = 2;
const DEFAULTS = {
  // Strecke: Start (= Wetterort) und Ziel; Rückfahrt ist der umgekehrte Weg
  startName: 'Wörgl', startLat: '47.4894', startLon: '12.0620',
  zielName: '', zielLat: '', zielLon: '',
  rideMin: '',                // Fahrzeit in Minuten, leer = aus der Entfernung
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
  if ('fixLat' in raw && !('startLat' in raw)) {                              // alter fester Standort → Start
    Object.assign(raw, { startLat: raw.fixLat, startLon: raw.fixLon, startName: raw.placeName || '' });
  }
  ['fixLat', 'fixLon', 'placeName'].forEach((k) => delete raw[k]);
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

// ---------- Strecke ----------
const ROAD_FACTOR = 1.3;   // Straße ist länger als die Luftlinie
function route(s, p) {
  const la1 = num(s.startLat, NaN), lo1 = num(s.startLon, NaN), la2 = num(s.zielLat, NaN), lo2 = num(s.zielLon, NaN);
  const manual = num(s.rideMin, NaN);
  if (![la1, lo1, la2, lo2].every(isNum)) return { km: null, bearing: null, min: isNum(manual) ? manual : 30 };
  const r = Math.PI / 180;
  const dLat = (la2 - la1) * r, dLon = (lo2 - lo1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD_FACTOR;
  const y = Math.sin(dLon) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) / r + 360) % 360;
  const auto = Math.max(5, Math.round(km / p.rideKmh * 60 / 5) * 5);
  return { km, bearing, auto, min: isNum(manual) ? manual : auto };
}

// ---------- Standort ----------
function getPosition() {
  const s = settings();
  const lat = num(s.startLat, NaN), lon = num(s.startLon, NaN);
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
// places: [{ hours, data }] – Start und (wenn weiter weg) Ziel; es zählt jeweils der schlechtere Wert.
function planShifts(places, s, p, rt) {
  const maps = places.map((pl) => new Map(pl.hours.map((h) => [h.t, h])));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const now = Date.now();
  const items = [];
  const dur = rt.min * 60e3;
  const back = isNum(rt.bearing) ? (rt.bearing + 180) % 360 : null;
  const floorH = (t) => Math.floor(t / HOUR) * HOUR, ceilH = (t) => Math.ceil(t / HOUR) * HOUR;
  // Eine Fahrt von depart bis arrive. Wetter: Stunde, in der die Fahrtmitte liegt.
  const ride = (name, depart, arrive, snowFrom, bearing) => {
    if (arrive <= now) return null;
    const key = floorH((depart + arrive) / 2) + HOUR;      // Stunden-Endzeitpunkt
    const hs = maps.map((m) => m.get(key) || m.get(key + HOUR)).filter(Boolean);
    const snows = places.map((pl) => snowRisk(floorH(snowFrom), ceilH(arrive), pl.data, p.snowCm));
    const snow = snows.reduce((x, y) => ((y.p ?? -1) > (x.p ?? -1) ? y : x));
    const prev = [];
    maps.forEach((m) => { for (let t = key - 6 * HOUR; t < key; t += HOUR) if (m.has(t)) prev.push(m.get(t)); });
    // Anzeige: die ungünstigere Stunde (mehr Regen) von Start und Ziel
    const h = hs.reduce((x, y) => ((y.prob ?? 0) > (x.prob ?? 0) ? y : x), hs[0]);
    return { name, from: depart, to: arrive, h, a: hs.length ? assessRide(hs, snow, p, prev, bearing) : null };
  };
  const at = (d, hour) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(hour), Math.round((hour % 1) * 60)).getTime();
  for (let i = -1; i <= 10; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    let sh = shiftFor(d, s);
    let outDep, outArr, backDep;
    if (sh) {
      const start = at(d, sh.s);
      outDep = start - dur; outArr = start;            // ankommen zu Schichtbeginn
      backDep = start + sh.len * HOUR;                 // losfahren zu Schichtende
    } else {
      if (i < 0) continue;
      const o = num(s.freeOut, 5), b = num(s.freeBack, 16);
      sh = { name: 'Frei', icon: 'calendar', cls: 'off', free: true, out: o, back: b };
      outDep = at(d, o); outArr = outDep + dur;
      backDep = at(d, b);
    }
    const backArr = backDep + dur;
    if (backArr <= now) continue;
    items.push({
      d, sh, i,
      rides: [
        ride('Hinfahrt', outDep, outArr, outDep - SNOW_BEFORE_H * HOUR, rt.bearing),   // Neuschnee der 6 h davor
        ride('Rückfahrt', backDep, backArr, outDep, back),                            // Schnee seit der Hinfahrt
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
  wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- Wettersymbol (klein, für die schnelle Übersicht) ----------
const CLOUD = '<path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/>';
const WX = {
  sun: ['<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>', 'sonnig'],
  moon: ['<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', 'klar'],
  sunCloud: ['<path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41M15.95 12.65a4 4 0 0 0-5.93-4.13"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>', 'leicht bewölkt'],
  moonCloud: ['<path d="M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z"/><path d="M10.1 9A6 6 0 0 1 16 4a4.24 4.24 0 0 0 6 6 6 6 0 0 1-3 5.2"/>', 'leicht bewölkt'],
  cloud: ['<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>', 'bewölkt'],
  fog: [CLOUD + '<path d="M16 17H7M17 21H9"/>', 'Nebel'],
  showers: [CLOUD + '<path d="M8 19v1M8 14v1M16 19v1M16 14v1M12 21v1M12 16v1"/>', 'evtl. Schauer'],
  rain: [CLOUD + '<path d="M16 14v6M8 14v6M12 16v6"/>', 'Regen'],
  snow: [CLOUD + '<path d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/>', 'Schnee'],
  thunder: ['<path d="M6 16.33A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.97"/><path d="m13 12-3 5h4l-3 5"/>', 'Gewitter'],
};
function wxKind(h, a) {
  if (!h) return null;
  const p = h.prob ?? 0;
  const snowy = (a && a.pSnow >= 25) || (h.snow && p >= 30);
  if (((a && a.pThunder) ?? h.pThunder ?? 0) >= 30) return 'thunder';
  if (p >= 50) return snowy ? 'snow' : 'rain';
  if (p >= 30) return snowy ? 'snow' : 'showers';
  if ((h.rh ?? 0) >= 98 && (h.wind ?? 9) < 2) return 'fog';
  const c = h.cloud ?? 100;
  if (c < 25) return h.day ? 'sun' : 'moon';
  if (c < 70) return h.day ? 'sunCloud' : 'moonCloud';
  return 'cloud';
}
const wxIcon = (h, a) => {
  const k = wxKind(h, a);
  return k ? `<svg class="i wx wx-${k}" viewBox="0 0 24 24" role="img" aria-label="${WX[k][1]}"><title>${WX[k][1]}</title>${WX[k][0]}</svg>` : '';
};

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
// "Wörgl Hauptbahnhof, Wörgl" → "Wörgl"; bei gleichem Ort für Start und Ziel der volle Name
const placeOf = (n) => String(n || '').split(',').pop().replace(/\d+/g, '').trim();
function routeNames(s) {
  let a1 = placeOf(s.startName), a2 = placeOf(s.zielName);
  if (a1 && a1 === a2) { a1 = s.startName.split(',')[0]; a2 = s.zielName.split(',')[0]; }
  return [a1 || 'Start', a2];
}

// Wind auf der Strecke als Kachel-Text
function windCell(r) {
  const head = r.a?.head;
  if (!isNum(head)) return [isNum(r.h.wind) ? `${fmt0(r.h.wind * 3.6)}` : '–', 'Wind km/h'];
  if (head >= 3) return [fmt0(head), 'Gegenwind'];
  if (head <= -3) return [fmt0(-head), 'Rückenwind'];
  return [fmt0(r.h.wind * 3.6), 'Seitenwind'];
}

function renderCurrent(items, rt, s) {
  const el = $('next');
  const it = items.find((x) => x.rides.length);
  if (!it) { el.hidden = true; return null; }
  const worst = worstOf(it.rides) || 'ok';
  el.className = `card next ${worst}`;
  el.hidden = false;
  const trend = it.rides.some((r) => r.a?.trend);
  const withA = it.rides.filter((r) => r.a);
  const sameClothes = withA.length === 2 && withA[0].a.clothes === withA[1].a.clothes;
  const cell = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
  const rideBlock = (r) => {
    const name = `<span class="cur-name">${wxIcon(r.h, r.a) || icon(r.name === 'Hinfahrt' ? 'work' : 'home')}${r.name} ${hr(r.from)}–${hr(r.to)}</span>`;
    if (!r.a) return `<div class="cur-ride"><div class="cur-row">${name}<span class="hint">keine Vorhersage</span></div></div>`;
    const a = r.a;
    const [wv, wl] = windCell(r);
    return `<div class="cur-ride">
      <div class="cur-row">${name}<span class="cur-verdict ${a.verdict}">${icon(a.verdict)}${VERDICT[a.verdict]}</span></div>
      ${a.reasons.length ? `<div class="cur-why ${a.verdict}">${esc(a.reasons.join(' · '))}</div>` : ''}
      <div class="mini num">${cell(deg(a.fMin), 'gefühlt')}${cell(pct(a.pMax), 'Regen')}${cell(pct(a.pSnow), 'Schnee')}${cell(pct(a.rh), 'Feuchte')}${cell(wv, wl)}</div>
      ${sameClothes ? '' : chips(a.clothes)}</div>`;
  };
  const shiftText = it.sh.free ? 'Frei' : `${it.sh.name}schicht ${fmtH(it.sh.s)}–${fmtH((it.sh.s + it.sh.len) % 24)}`;
  const [n1, n2] = routeNames(s);
  const routeText = `${esc(n1)}${s.zielName ? ` → ${esc(n2)}` : ''}${isNum(rt.km) ? ` · ${fmt0(rt.km)} km` : ''} · ${fmt0(rt.min)} min`;
  const past = it.rides.length === 1 && it.rides[0].name === 'Rückfahrt' ? '<div class="hint">Hinfahrt bereits vorbei</div>' : '';
  el.innerHTML = `
    <div class="cur-top">
      <span class="badge ${it.sh.cls}"><span class="dot">${icon(it.sh.icon)}</span></span>
      <div class="cur-title"><b>${dayLabel(it.i, it.d)} · ${shiftText}</b><span>${icon('route')}${routeText}</span></div>
      ${trend ? '<span class="tag">Trend</span>' : ''}
      <a class="radar-btn" href="${RADAR_URL}" target="_blank" rel="noopener" title="Regenradar von GeoSphere Austria">${icon('radar')}Radar</a>
    </div>
    ${past}${it.rides.map(rideBlock).join('')}
    ${sameClothes ? `<div class="cur-ride"><div class="overline">Kleidung · Hin &amp; Rück</div>${chips(withA[0].a.clothes)}</div>` : ''}`;
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
    else if (bad((a) => a.pThunder >= 50)) notes.stop.push([who, `${where((a) => a.pThunder >= 50)}: Gewitter – besser nicht mit dem Rad${unsure}.`]);
    else if (bad((a) => a.pHeavy >= 50)) notes.stop.push([who, `${where((a) => a.pHeavy >= 50)}: viel Regen – besser nicht mit dem Rad${unsure}.`]);
    const stopped = bad((a) => a.pSnow >= 50) || bad((a) => a.pHeavy >= 50) || bad((a) => a.pThunder >= 50);
    const issues = (a) => [
      !stopped && a.pThunder >= 20 ? 'Gewitter möglich' : null,
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
  const name = `<span class="ride-name">${wxIcon(r.h, r.a) || icon(r.name === 'Hinfahrt' ? 'work' : 'home')}${r.name} ${hr(r.from)}–${hr(r.to)} Uhr</span>`;
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
    return `<div class="ride ok"><div class="ride-row"><span class="ride-name"><span class="wx2">${wxIcon(h.h, h.a)}${wxIcon(r.h, r.a)}</span>Hin- und Rückfahrt</span>${pill('ok')}</div></div>`;
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
const RADAR_URL = 'https://www.geosphere.at/de/karten/wetterportal';
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
    $('place').innerHTML = `${icon('pin')}${esc(placeOf(s.startName) || (pos.fixed ? 'Start' : 'GPS-Standort'))}` +
      (isNum(h0?.temp) ? ` · jetzt ${deg(h0.temp)}, gefühlt ${deg(h0.feel)}` : '') + (pos.stale ? ' · letzter Standort' : '');

    const rt = route(s, p);
    const places = [{ hours, data: { gs, om, ecm } }];
    // Ziel mehr als 3 km entfernt → dort auch das Wetter prüfen
    const zLat = num(s.zielLat, NaN), zLon = num(s.zielLon, NaN);
    let zielOk = false;
    if (isNum(rt.km) && rt.km > 3 && isNum(zLat) && isNum(zLon)) {
      const [gz, oz, ez] = await Promise.all([fetchGeoSphere(zLat, zLon), fetchOpenMeteo(zLat, zLon), fetchEcmwf(zLat, zLon)]);
      const hz = buildHours({ lat: zLat, lon: zLon }, gz, oz, ez, { heavyMm: p.heavyMm, rideKmh: p.rideKmh, hours: 24 * 12 });
      if (hz.length) { places.push({ hours: hz, data: { gs: gz, om: oz, ecm: ez } }); zielOk = true; }
    }
    const items = planShifts(places, s, p, rt);
    const current = renderCurrent(items, rt, s);
    renderSummary(items, s);
    renderShifts(items, current);

    const names = { nwp: 'GeoSphere', ens: 'GeoSphere-Ensemble', now: 'Radar' };
    const ok = Object.keys(gs.res).map((k) => names[k]);
    if (om.rows) ok.push('ICON-D2');
    if (ecm.rows) ok.push('ECMWF');
    const msgs = [`Stand ${timeFmt.format(new Date())} · ${ok.join(', ') || 'keine Quellen'}${zielOk ? ' · Wetter an Start und Ziel' : ''}`];
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
function formValues() { const o = {}; FIELDS.forEach((f) => { o[f] = $(f).value.trim(); }); return o; }
function showPlace(which) {
  const name = $(which + 'Name').value, lat = $(which + 'Lat').value;
  $(which + 'Found').innerHTML = name && lat ? `<span class="ok">✓</span> ${esc(name)}` : (which === 'ziel' ? 'Noch kein Ziel – ohne Ziel kein Gegenwind, Fahrzeit 30 min.' : '');
}
function updateRideHint() {
  const v = formValues();
  const rt = route(v, prefs(v));
  $('rideHint').textContent = isNum(rt.km)
    ? `Strecke ca. ${fmt0(rt.km)} km → automatisch ${rt.auto} min bei ${fmt0(num(v.rideKmh, 20))} km/h. Leer lassen = automatisch.`
    : 'Leer = 30 min (ohne Ziel). Mit Ziel wird die Zeit aus der Entfernung berechnet.';
}
// Textfelder wachsen mit dem Inhalt mit
const autoSize = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
document.querySelectorAll('#settings textarea').forEach((t) => t.addEventListener('input', () => autoSize(t)));
function fillForm(s) {
  FIELDS.forEach((f) => { $(f).value = s[f]; });
  requestAnimationFrame(() => document.querySelectorAll('#settings textarea').forEach(autoSize));
  $('startQ').value = s.startName; $('zielQ').value = s.zielName;
  showPlace('start'); showPlace('ziel'); updateRideHint();
}
// Adresssuche über Photon (OpenStreetMap-Daten), bevorzugt Treffer in der Nähe des Starts
async function findPlace(which) {
  const q = $(which + 'Q').value.trim();
  const box = $(which + 'Found');
  if (!q) { box.textContent = 'Bitte Adresse oder Ort eingeben.'; return; }
  box.textContent = 'Suche …';
  try {
    const bias = `&lat=${num($('startLat').value, 47.49)}&lon=${num($('startLon').value, 12.06)}`;
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=de${bias}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const seen = new Set();
    const hits = ((await r.json()).features || []).filter((f) => {      // doppelte Treffer weglassen
      const p = f.properties, k = [p.name, p.street, p.housenumber, p.city].join('|');
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    if (!hits.length) { box.textContent = 'Nichts gefunden – anders schreiben (z. B. mit Ort).'; return; }
    box.innerHTML = hits.map((f, k) => {
      const p = f.properties;
      const label = [p.name, [p.street, p.housenumber].filter(Boolean).join(' '), [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' ')]
        .filter((x, i, arr) => x && arr.indexOf(x) === i).join(', ');
      const short = [p.name || [p.street, p.housenumber].filter(Boolean).join(' '), p.city || p.town || p.village].filter(Boolean)
        .filter((x, i, arr) => arr.indexOf(x) === i).join(', ');
      return `<button type="button" class="pick" data-k="${k}" data-short="${esc(short)}">${esc(label)}</button>`;
    }).join('');
    box.querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => {
      const f = hits[+b.dataset.k];
      $(which + 'Name').value = b.dataset.short;
      $(which + 'Lat').value = f.geometry.coordinates[1].toFixed(5);
      $(which + 'Lon').value = f.geometry.coordinates[0].toFixed(5);
      $(which + 'Q').value = $(which + 'Name').value;
      showPlace(which); updateRideHint();
    }));
  } catch (e) {
    box.textContent = 'Suche nicht erreichbar: ' + e.message;
  }
}
document.querySelectorAll('[data-find]').forEach((b) => {
  b.innerHTML = icon('search');
  b.addEventListener('click', () => findPlace(b.dataset.find));
});
['startQ', 'zielQ'].forEach((id) => $(id).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findPlace(id.slice(0, -1)); }
}));
$('zielQ').addEventListener('input', () => {   // Ziel geleert → Ziel entfernen
  if (!$('zielQ').value.trim()) { ['zielName', 'zielLat', 'zielLon'].forEach((f) => { $(f).value = ''; }); showPlace('ziel'); updateRideHint(); }
});
['rideMin', 'rideKmh'].forEach((id) => $(id).addEventListener('input', updateRideHint));
$('btnSettings').addEventListener('click', () => { fillForm(settings()); $('settings').showModal(); });
$('btnDefaults').addEventListener('click', () => fillForm(DEFAULTS));
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  store('settings', Object.assign({ v: SETTINGS_VERSION }, formValues()));
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
