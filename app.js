'use strict';
// Oberfläche. Rechnungen und Datenquellen stehen in core.js.

const $ = (id) => document.getElementById(id);

// ---------- Einstellungen ----------
const SETTINGS_VERSION = 2;
const DEFAULTS = {
  fixLat: '47.4894', fixLon: '12.0620', placeName: 'Wörgl',
  cycleStart: '2026-11-24',   // erster Frühdienst eines Schichtrads
  heavyMm: '0.5',             // mehr als Tröpfeln
  snowCm: '1',
  rideKmh: '20',
  l1: '10', l1t: 'Handschuhe, Kappe, Fleece, Iso, Windjacke, Isohose',
  l2: '15', l2t: 'Fleece, Windjacke, Radhose',
  l3: '20', l3t: 'Fleece, lange Radhose',
  l4t: 'Alles kurz',
};
function settings() {
  const raw = load('settings', {});
  if ((raw.v || 1) < SETTINGS_VERSION) delete raw.heavyMm;   // alte Grenze (2 mm) durch neue ersetzen
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
// 10-Tage-Rad: 2× Früh, 2× Spät, 2× Nacht, 4 Tage frei.
const EARLY = { name: 'Früh', icon: '🌅', color: 'c-orange', s: 6, len: 8 };
const LATE = { name: 'Spät', icon: '🌇', color: 'c-purple', s: 14, len: 8 };
const NIGHT = { name: 'Nacht', icon: '🌙', color: 'c-night', s: 22, len: 8 };
const CYCLE = [EARLY, EARLY, LATE, LATE, NIGHT, NIGHT, null, null, null, null];
const DAY = 86400e3;
const SNOW_BEFORE_H = 6;   // Hinweg: Neuschnee der letzten 6 Stunden zählt

function parseDate(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function shiftFor(date, cycleStart) {
  const diff = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - parseDate(cycleStart)) / DAY);
  return CYCLE[((diff % CYCLE.length) + CYCLE.length) % CYCLE.length];
}
function shiftOrdinal(d, s) {
  const sh = shiftFor(d, s.cycleStart);
  const prev = shiftFor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1), s.cycleStart);
  return `${prev === sh ? 'zweiten' : 'ersten'} ${sh.name}schicht`;
}

// Alle Schichten (gestern bis +10 Tage) mit bewerteten Fahrten.
function planShifts(hours, data, s, p) {
  const byT = new Map(hours.map((h) => [h.t, h]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const now = Date.now();
  const items = [];
  for (let i = -1; i <= 10; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const sh = shiftFor(d, s.cycleStart);
    if (!sh) { if (i >= 0) items.push({ free: true, d }); continue; }
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh.s).getTime();
    const end = start + sh.len * HOUR;
    if (end + HOUR <= now) continue;
    const ride = (name, key, snowFrom, snowTo) => {
      if (key <= now) return null;
      const h = byT.get(key);
      const snow = snowRisk(snowFrom, snowTo, data, p.snowCm);
      return { name, from: key - HOUR, to: key, h, a: h ? assessRide([h], snow, p) : null };
    };
    items.push({
      d, sh, i, start, end,
      rides: [
        ride('Hinweg', start, start - SNOW_BEFORE_H * HOUR, start),
        ride('Heimweg', end + HOUR, start - HOUR, end + HOUR),   // Schnee während der ganzen Schicht
      ].filter(Boolean),
    });
  }
  return items;
}

// ---------- Darstellung ----------
const shortDayFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'short', day: 'numeric', month: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });
const hr = (t) => String(new Date(t).getHours());
const VERDICT = { ok: ['✅', 'Fahren'], warn: ['⚠️', 'Aufpassen'], stop: ['🚫', 'Nicht fahren'] };
const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const deg = (x) => (isNum(x) ? `${fmt0(x)}°` : '–');
const dayLabel = (i, d) => (i === 0 ? 'Heute' : i === 1 ? 'Morgen' : i === -1 ? 'Gestern' : shortDayFmt.format(d));
const worstOf = (rides) => {
  const v = rides.map((r) => r.a?.verdict).filter(Boolean);
  return v.includes('stop') ? 'stop' : v.includes('warn') ? 'warn' : v.length ? 'ok' : null;
};

function renderNext(items) {
  const el = $('next');
  let found = null;
  for (const it of items) {
    if (it.free) continue;
    const r = it.rides.find((x) => x.a);
    if (r) { found = { it, r }; break; }
  }
  if (!found) { el.hidden = true; return; }
  const { it, r } = found;
  const a = r.a;
  el.className = `card next ${a.verdict}`;
  el.hidden = false;
  el.innerHTML = `
    <div class="when">Nächste Fahrt · ${dayLabel(it.i, it.d)} · ${r.name} ${hr(r.from)}–${hr(r.to)} Uhr${a.trend ? ' <span class="trend">Trend</span>' : ''}</div>
    <div class="verdict">${VERDICT[a.verdict][0]} ${VERDICT[a.verdict][1]}</div>
    ${a.reasons.length ? `<div class="why">${esc(a.reasons.join(' · '))}</div>` : ''}
    <div class="kv">
      <div><div class="label">Gefühlt</div><div class="val">${deg(r.h.feel)}</div></div>
      <div><div class="label">Luft</div><div class="val">${deg(r.h.temp)}</div></div>
      <div><div class="label">Regen</div><div class="val">${fmt0(r.h.prob)} %</div></div>
      <div><div class="label">Schnee</div><div class="val">${fmt0(a.pSnow)} %</div></div>
    </div>
    <div class="label">Anziehen</div>
    <div class="clothes">${esc(a.clothes)}</div>`;
}

function renderSummary(items, s) {
  const notes = { stop: [], warn: [], none: 0 };
  for (const it of items) {
    if (it.free || !it.rides.length) continue;
    if (it.rides.some((r) => !r.a)) { notes.none++; if (!it.rides.some((r) => r.a)) continue; }
    const who = `Bei der ${shiftOrdinal(it.d, s)} (${dayLabel(it.i, it.d).replace(/^(Heute|Morgen)$/, (m) => m.toLowerCase())})`;
    const where = (pred) => {
      const n = it.rides.filter((r) => r.a && pred(r.a)).map((r) => r.name);
      return n.length === 2 ? 'am Hin- und Heimweg' : `am ${n[0]}`;
    };
    const unsure = it.rides.some((r) => r.a?.trend) ? ' (noch unsicher)' : '';
    const bad = (k) => it.rides.some((r) => r.a && k(r.a));
    if (bad((a) => a.pSnow >= 50)) notes.stop.push(`${who} ist ${where((a) => a.pSnow >= 50)} mit Schneefahrbahn zu rechnen – mit dem Rad wird's nichts${unsure}.`);
    else if (bad((a) => a.pHeavy >= 50)) notes.stop.push(`${who} ist ${where((a) => a.pHeavy >= 50)} mit viel Regen zu rechnen – besser nicht mit dem Rad${unsure}.`);
    // Warnungen einer Schicht in einem Satz, nach Fahrt gruppiert
    const stopped = bad((a) => a.pSnow >= 50) || bad((a) => a.pHeavy >= 50);
    const issues = (a) => [
      !stopped && a.pSnow >= 25 ? 'evtl. Schnee auf der Fahrbahn' : null,
      !stopped && a.pHeavy >= 25 ? 'evtl. stärkerer Regen' : null,
      a.ice && a.pSnow < 25 ? 'Glättegefahr' : null,
      a.storm ? 'Sturmböen' : null,
    ].filter(Boolean).join(' und ');
    const per = it.rides.filter((r) => r.a && issues(r.a)).map((r) => [r.name, issues(r.a)]);
    let w = per.map(([n, t]) => `am ${n} ${t}`);
    if (per.length === 2 && per[0][1] === per[1][1]) w = [`am Hin- und Heimweg ${per[0][1]}`];
    if (w.length) notes.warn.push(`${who}: ${w.join(', ')}${unsure}.`);
  }
  const lines = [];
  if (!notes.stop.length) {
    lines.push(`<p class="sum ok">✅ <b>Fahrten im ganzen Schichtrad möglich</b>${notes.warn.length ? ' – an einzelnen Tagen aufpassen:' : ' – kein Schnee und kein Starkregen in Sicht.'}</p>`);
  }
  notes.stop.forEach((t) => lines.push(`<p class="sum stop">🚫 ${t}</p>`));
  notes.warn.forEach((t) => lines.push(`<p class="sum warn">⚠️ ${t}</p>`));
  if (notes.none) lines.push(`<p class="sum muted">Für ${notes.none === 1 ? 'eine Schicht' : notes.none + ' Schichten'} gibt es noch keine Vorhersage.</p>`);
  $('shiftSummary').innerHTML = lines.join('');
}

function rideHtml(r) {
  const lbl = `${r.name} ${hr(r.from)}–${hr(r.to)} Uhr`;
  if (!r.a) return `<div class="ride none"><div class="ride-top"><span class="lbl">${lbl}</span></div>noch keine Vorhersage</div>`;
  const a = r.a;
  return `<div class="ride ${a.verdict}">
    <div class="ride-top"><span class="lbl">${lbl}</span><span class="v">${VERDICT[a.verdict][0]} ${VERDICT[a.verdict][1]}</span></div>
    <div class="ride-info">gefühlt <b>${deg(r.h.feel)}</b> · Regen <b>${fmt0(r.h.prob)} %</b>${a.pSnow >= 5 ? ` · Schnee <b>${fmt0(a.pSnow)} %</b>` : ''}${a.reasons.length ? ` · <span class="w">${esc(a.reasons.join(', '))}</span>` : ''}</div>
    <div class="ride-cloth">${esc(a.clothes)}</div></div>`;
}

function renderShifts(items) {
  const html = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.free) {
      let j = k;
      while (j + 1 < items.length && items[j + 1].free) j++;
      const n = j - k + 1;
      const range = n === 1 ? shortDayFmt.format(it.d) : `${shortDayFmt.format(it.d)} – ${shortDayFmt.format(items[j].d)}`;
      html.push(`<div class="free"><span class="circ c-green">🏖️</span><div><b style="color:var(--text)">${n === 1 ? 'Frei' : `${n} Tage frei`}</b><br>${range}</div></div>`);
      k = j;
      continue;
    }
    const worst = worstOf(it.rides);
    const trend = it.rides.some((r) => r.a?.trend);
    html.push(`<div class="shift">
      <div class="sh-head"><span class="circ ${it.sh.color}">${it.sh.icon}</span>
        <div><div class="title">${dayLabel(it.i, it.d)}${trend ? '<span class="trend" title="Langfrist-Trend, noch unsicher">Trend</span>' : ''}</div>
        <div class="sub">${it.sh.name}schicht ${it.sh.s}–${(it.sh.s + it.sh.len) % 24} Uhr</div></div>
        ${worst ? `<span class="v">${VERDICT[worst][0]}</span>` : ''}</div>
      ${it.rides.map(rideHtml).join('')}</div>`);
  }
  $('shifts').innerHTML = html.join('');
}

function setStatus(parts) { $('status').innerHTML = parts.filter(Boolean).join('<br>'); }

// ---------- Hauptablauf ----------
let busy = false;
async function run() {
  if (busy) return;
  busy = true;
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
    $('place').textContent = `📍 ${s.placeName || (pos.fixed ? 'Fester Standort' : 'GPS-Standort')}` +
      (isNum(h0?.temp) ? ` · jetzt ${deg(h0.temp)}, gefühlt ${deg(h0.feel)}` : '') + (pos.stale ? ' · letzter Standort' : '');

    const items = planShifts(hours, { gs, om, ecm }, s, p);
    renderNext(items);
    renderSummary(items, s);
    renderShifts(items);

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
try { Object.keys(localStorage).filter((k) => k.startsWith('om-')).forEach((k) => localStorage.removeItem(k)); } catch (_) {}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
run();
