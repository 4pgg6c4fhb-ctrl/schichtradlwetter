'use strict';
// Oberfläche. Rechnungen und Datenquellen stehen in core.js.

const $ = (id) => document.getElementById(id);

function settings() {
  // Standard: Wörgl (Tirol). In den Einstellungen änderbar; Felder leeren = GPS.
  // cycleStart: erster Frühdienst (6–14) eines Schichtrads. heavyMm: ab so viel Regen pro Stunde wird nicht geradelt.
  return Object.assign({ fixLat: '47.4894', fixLon: '12.0620', placeName: 'Wörgl', cycleStart: '2026-11-24', heavyMm: '2' },
    load('settings', {}));
}

// ---------- Standort ----------
function getPosition() {
  const s = settings();
  const lat = parseFloat(String(s.fixLat).replace(',', '.'));
  const lon = parseFloat(String(s.fixLon).replace(',', '.'));
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
const EARLY = { name: 'Früh', icon: '🌅', s: 6, len: 8 };
const LATE = { name: 'Spät', icon: '🌇', s: 14, len: 8 };
const NIGHT = { name: 'Nacht', icon: '🌙', s: 22, len: 8 };
const CYCLE = [EARLY, EARLY, LATE, LATE, NIGHT, NIGHT, null, null, null, null];
const DAY = 86400e3;

function parseDate(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function shiftFor(date, cycleStart) {
  const diff = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - parseDate(cycleStart)) / DAY);
  return CYCLE[((diff % CYCLE.length) + CYCLE.length) % CYCLE.length];
}

// ---------- Darstellung ----------
const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });
const hr = (t) => String(new Date(t).getHours());
const dayFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'long', day: 'numeric', month: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'short', day: 'numeric', month: 'numeric' });
const wdFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'short' });
const VERDICT = { ok: ['✅', 'Fahren'], warn: ['⚠️', 'Aufpassen'], stop: ['🚫', 'Nicht fahren: zu starker Regen'] };
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// Symbol-Kacheln; Punkte = Stufe (dünn/mittel/dick). Text erscheint erst nach Antippen der Karte.
function tiles(list, cls = '') {
  return list.map(([icon, text, level]) =>
    `<span class="tile ${cls}" title="${esc(text)}">${icon}${level ? `<i>${'•'.repeat(level)}</i>` : ''}<small>${esc(text)}</small></span>`).join('');
}

function renderNow(hours) {
  const h = hours[0];
  if (!h) return;
  $('nowIcon').textContent = h.icon;
  $('nowTemp').textContent = isNum(h.temp) ? `${fmt1(h.temp)}°` : '–';
  $('nowFeel').textContent = isNum(h.feel) ? `🚲 ${fmt0(h.feel)}°` : '';
  const wind = isNum(h.wind) ? ` · 💨 ${fmt0(h.wind * 3.6)} km/h` + (isNum(h.gust) ? ` (${fmt0(h.gust * 3.6)})` : '') : '';
  $('nowDesc').textContent = (h.desc || '') + wind;
  $('nowProb').textContent = isNum(h.prob) ? `💧 ${fmt0(h.prob)} %` : '–';
  const next6 = hours.slice(0, 6).map((x) => x.prob).filter(isNum);
  const max6 = next6.length ? Math.max(...next6) : null;
  $('nowProbText').textContent = 'nächste Stunde' + (isNum(max6) ? ` · max. ${fmt0(max6)} % in 6 h` : '');
}

function renderClothing(hours) {
  const c = clothing(hours.slice(0, 12));
  $('clothCard').hidden = !c;
  if (!c) return;
  $('clothSummary').innerHTML = `🌡️ ${fmt0(c.tMin)}…${fmt0(c.tMax)}° · 🚲 ${fmt0(c.fMin)}° · 💧 ${fmt0(c.pMax)} %`;
  $('clothList').innerHTML = tiles(c.warnings, 'warn') + tiles(c.items);
}

// Eine Fahrt (Hin oder Heim): Stunde suchen, Ampel + Kleidung als Symbole.
function rideHtml(label, hourKey, byT) {
  const h = byT.get(hourKey);
  if (hourKey <= Date.now()) return '';
  if (!h) return `<div class="ride"><span class="lbl">${label}</span><span class="muted">noch keine Vorhersage</span></div>`;
  const c = clothing([h]);
  const [vi, vt] = VERDICT[c.verdict];
  return `<div class="ride ${c.verdict}">
    <span class="lbl">${label}</span>
    <span class="v" title="${vt}">${vi}</span>
    <span class="num">🚲 ${fmt0(h.feel)}°</span>
    <span class="num">💧 ${fmt0(h.prob)} %</span>
    <span class="tiles">${tiles(c.warnings, 'warn')}${tiles(c.items)}</span></div>`;
}

function renderShifts(hours, s) {
  const byT = new Map(hours.map((h) => [h.t, h]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const html = [];
  const problems = [];
  let free = null;
  const flushFree = () => {
    if (!free) return;
    const range = free.from === free.to ? shortDayFmt.format(free.from) : `${shortDayFmt.format(free.from)} – ${shortDayFmt.format(free.to)}`;
    html.push(`<div class="shift free">🏖️ frei · ${range}</div>`);
    free = null;
  };
  for (let i = -1; i <= 10; i++) {                       // gestern (Nachtdienst bis 6 Uhr) bis +10 Tage
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const sh = shiftFor(d, s.cycleStart);
    if (!sh) {
      if (i < 0) continue;
      if (!free) free = { from: d, to: d }; else free.to = d;
      continue;
    }
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh.s).getTime();
    const end = start + sh.len * HOUR;
    if (end + HOUR <= Date.now()) continue;            // schon vorbei
    flushFree();
    const hin = rideHtml(`➡️ ${hr(start - HOUR)}–${hr(start)}`, start, byT);
    const heim = rideHtml(`⬅️ ${hr(end)}–${hr(end + HOUR)}`, end + HOUR, byT);
    const rides = [byT.get(start), byT.get(end + HOUR)].filter((h, k) => h && [start, end + HOUR][k] > Date.now());
    const verdicts = rides.map((h) => clothing([h]));
    const worst = verdicts.some((v) => v.verdict === 'stop') ? 'stop' : verdicts.some((v) => v.verdict === 'warn') ? 'warn' : 'ok';
    const trend = rides.some((h) => h.range === 'lang');
    const label = `${i === 0 ? 'Heute' : i === 1 ? 'Morgen' : shortDayFmt.format(d)}`;
    if (rides.length && worst !== 'ok') {
      const icons = [...new Set(verdicts.flatMap((v) => v.warnings.map((w) => w[0])))].join('');
      problems.push(`${VERDICT[worst][0]} ${label} ${sh.icon} ${icons}`);
    }
    html.push(`<div class="shift">
      <div class="sh-head"><b>${label}</b> ${sh.icon} ${sh.name} ${sh.s}–${(sh.s + sh.len) % 24}
        ${rides.length ? `<span class="v">${VERDICT[worst][0]}</span>` : ''}${trend ? '<span class="trend" title="Langfrist-Trend (ECMWF), noch unsicher">≈ Trend</span>' : ''}</div>
      ${hin}${heim}</div>`);
  }
  flushFree();
  $('shiftSummary').innerHTML = problems.length
    ? problems.map((p) => `<span class="prob-chip">${p}</span>`).join('')
    : '<span class="prob-chip ok">✅ Keine Wetterprobleme in Sicht</span>';
  $('shifts').innerHTML = html.join('');
}

function renderNowcast(gs) {
  const rows = gs.res.now?.rows;
  const card = $('nowcastCard');
  if (!rows || !rows.size) { card.hidden = true; return; }
  const list = [...rows.entries()].filter(([t]) => t > Date.now() - 15 * 60e3).slice(0, 12);
  const max = Math.max(0.5, ...list.map(([, r]) => r.rr || 0));
  $('nowcast').innerHTML = list.map(([t, r]) =>
    `<div title="${timeFmt.format(t)}: ${fmt1(r.rr)} mm" style="height:${Math.max(3, 100 * (r.rr || 0) / max)}%"></div>`).join('');
  const lab = list.filter((_, i) => i % 4 === 0).map(([t]) => `<span>${timeFmt.format(t)}</span>`);
  $('nowcastLabels').innerHTML = lab.join('');
  const total = list.reduce((s, [, r]) => s + (r.rr || 0), 0);
  card.hidden = false;
  card.querySelector('h2 .muted').textContent = total < 0.05 ? '(trocken laut Radar)' : `(${fmt1(total)} mm laut Radar)`;
}

function renderDays(hours) {
  const byDay = new Map();
  for (const h of hours) {
    const key = new Date(h.t).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(h);
  }
  $('days').innerHTML = [...byDay.values()].slice(0, 7).map((hs) => {
    const temps = hs.map((h) => h.temp).filter(isNum);
    const feels = hs.map((h) => h.feel).filter(isNum);
    const probs = hs.map((h) => h.prob).filter(isNum);
    // Wahrscheinlichkeit für "irgendwann Regen" = 1 - Π(1-p) wäre zu hoch (Stunden sind korreliert) → Maximum.
    const pmax = probs.length ? Math.max(...probs) : null;
    const rep = hs.reduce((a, b) => ((b.prob ?? 0) > (a.prob ?? 0) ? b : a), hs[Math.floor(hs.length / 2)]);
    const dayIcon = symbol(Object.assign({}, rep, { day: true }))[0];
    const d = new Date(hs[0].t);
    const name = d.toDateString() === new Date().toDateString() ? 'Heute' : wdFmt.format(d);
    return `<div class="day${hs.some((h) => h.range === 'lang') ? ' trend' : ''}"><div>${name}</div><div class="i">${dayIcon}</div>
      <div>${temps.length ? `${fmt0(Math.min(...temps))}° / ${fmt0(Math.max(...temps))}°` : '–'}</div>
      <div class="muted">🚲 ${feels.length ? fmt0(Math.min(...feels)) + '°' : '–'}</div>
      <div class="p">💧 ${isNum(pmax) ? fmt0(pmax) + ' %' : '–'}</div></div>`;
  }).join('');
}

function renderHours(hours) {
  let lastDay = '';
  const html = [];
  for (const h of hours) {
    const d = new Date(h.t);
    const dk = d.toDateString();
    if (dk !== lastDay) {
      lastDay = dk;
      html.push(`<tr class="daysep"><td colspan="5">${dayFmt.format(d)}</td></tr>`);
    }
    const p = isNum(h.prob) ? Math.round(h.prob) : null;
    const s = h.src;
    const parts = [
      isNum(s.pNc) ? `Nowcast ${fmt0(s.pNc)} % (${fmt1(s.nowcastMm)} mm, Gewicht ${fmt0(s.wNc * 100)} %)` : null,
      isNum(s.pEns) ? `Ensemble ${fmt0(s.pEns)} % (P10/50/90: ${s.ens.map(fmt1).join(' / ')} mm)` : null,
      isNum(s.pNwp) ? `GeoSphere ${fmt0(s.pNwp)} % (${fmt1(s.nwpMm)} mm)` : null,
      isNum(s.pOm) ? `ICON-D2 ${fmt0(s.pOm)} % (${Math.round(s.pOm * s.omN / 100)} von ${s.omN} Läufen, Median ${fmt1(s.omMm)} mm)` : null,
      isNum(s.pEcm) ? `ECMWF ${fmt0(s.pEcm)} % (${Math.round(s.pEcm * s.ecmN / 100)} von ${s.ecmN} Läufen)` : null,
      isNum(h.pHeavy) && h.pHeavy >= 1 ? `Starkregen ${fmt0(h.pHeavy)} %` : null,
    ].filter(Boolean);
    html.push(`<tr class="h" data-t="${h.t}">
      <td class="t">${timeFmt.format(d)}</td>
      <td class="i" title="${h.desc}">${h.icon}</td>
      <td class="tmp">${isNum(h.temp) ? fmt0(h.temp) + '°' : '–'}<small>🚲 ${fmt0(h.feel)}°</small></td>
      <td class="pb"><div class="bar"><span style="width:${p ?? 0}%"></span><em>${p == null ? '–' : p + ' %'}</em></div></td>
      <td class="mm">${isNum(h.mm) && h.mm >= 0.05 ? fmt1(h.mm) + ' mm' : ''}</td></tr>
      <tr class="detail" data-for="${h.t}" hidden><td></td><td colspan="4">${parts.join(' · ')}${isNum(h.wind) ? ` · Wind ${fmt0(h.wind * 3.6)} km/h` : ''}</td></tr>`);
  }
  $('hours').innerHTML = html.join('');
}

$('hours').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr.h');
  if (!tr) return;
  const det = $('hours').querySelector(`tr.detail[data-for="${tr.dataset.t}"]`);
  if (det) det.hidden = !det.hidden;
});
// Antippen einer Karte mit Symbolen blendet die Erklärtexte ein/aus.
document.querySelectorAll('.tap-text').forEach((el) => el.addEventListener('click', () => el.classList.toggle('show-text')));

function setStatus(parts) { $('status').innerHTML = parts.filter(Boolean).join('<br>'); }

// ---------- Hauptablauf ----------
let busy = false;
async function run() {
  if (busy) return;
  busy = true;
  const s = settings();
  try {
    setStatus(['Standort wird ermittelt …']);
    const pos = await getPosition();
    if (!pos.fixed && !pos.stale) store('lastPos', { lat: pos.lat, lon: pos.lon, acc: pos.acc });
    const name = s.placeName || (pos.fixed ? 'Fester Standort' : 'GPS-Standort');
    $('place').textContent = `${name} · ${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` +
      (pos.acc ? ` (±${Math.round(pos.acc)} m)` : '') + (pos.stale ? ' · letzter bekannter' : '');

    setStatus(['Lade GeoSphere und Open-Meteo …']);
    const [gs, om, ecm] = await Promise.all([
      fetchGeoSphere(pos.lat, pos.lon), fetchOpenMeteo(pos.lat, pos.lon), fetchEcmwf(pos.lat, pos.lon)]);
    const heavyMm = parseFloat(String(s.heavyMm).replace(',', '.')) || 2;
    const hours = buildHours(pos, gs, om, ecm, { heavyMm, hours: 24 * 12 });

    const names = { nwp: 'GeoSphere-Modell', ens: 'GeoSphere-Ensemble', now: 'Nowcast' };
    const msgs = [];
    const ok = Object.keys(gs.res).map((k) => names[k]);
    if (om.rows) ok.push('ICON-D2');
    if (ecm.rows) ok.push('ECMWF');
    msgs.push(`Stand ${timeFmt.format(new Date())} · Quellen: ${ok.join(', ') || 'keine'}`);
    for (const [k, e] of Object.entries(gs.errors)) msgs.push(`<span class="warn">${names[k]}: ${e}</span>`);
    if (om.error) msgs.push(`<span class="warn">ICON-D2: ${om.error}</span>`);
    if (ecm.error) msgs.push(`<span class="warn">ECMWF: ${ecm.error}</span>`);

    if (!hours.length) throw new Error('Keine Vorhersagedaten für diesen Ort (GeoSphere deckt Mitteleuropa ab).');
    renderNow(hours);
    renderShifts(hours, s);
    renderClothing(hours);
    renderNowcast(gs);
    renderDays(hours);
    renderHours(hours.slice(0, 48));
    setStatus(msgs);
  } catch (e) {
    setStatus([`<span class="err">${e.message}</span>`]);
  } finally {
    busy = false;
  }
}

// ---------- Einstellungen ----------
const FIELDS = ['fixLat', 'fixLon', 'placeName', 'cycleStart', 'heavyMm'];
$('btnSettings').addEventListener('click', () => {
  const s = settings();
  FIELDS.forEach((f) => { $(f).value = s[f]; });
  $('settings').showModal();
});
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const next = {};
  FIELDS.forEach((f) => { next[f] = $(f).value.trim(); });
  store('settings', next);
  run();
});
$('btnReload').addEventListener('click', () => {
  try { Object.keys(localStorage).filter((k) => /^(gs-|om-)/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
  run();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
run();
