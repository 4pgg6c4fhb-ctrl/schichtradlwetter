'use strict';

// ---------- Konfiguration ----------
const GS = 'https://dataset.api.hub.geosphere.at/v1/timeseries/forecast';
const OM = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const THRESHOLD_MM = 0.1;            // "es regnet" ab 0,1 mm pro Stunde
const WEIGHTS = { ens: 0.4, nwp: 0.2, om: 0.4 };
const NOWCAST_HOURS = 3;             // Nowcast-Einfluss klingt bis hierhin linear aus
const HOURS_SHOWN = 48;
const HOUR = 3600e3;

// ---------- kleine Helfer ----------
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const avg = (arr) => { const v = arr.filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fmt1 = (x) => isNum(x) ? x.toLocaleString('de-AT', { maximumFractionDigits: 1 }) : '–';
const fmt0 = (x) => isNum(x) ? Math.round(x).toString() : '–';

function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
function load(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
}

function settings() {
  return Object.assign({ fixLat: '', fixLon: '', placeName: '' }, load('settings', {}));
}

async function cachedJson(cacheKey, ttlMs, url, opts) {
  const c = load(cacheKey);
  if (c && Date.now() - c.t < ttlMs) return c.d;
  const r = await fetch(url, opts);
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const d = await r.json();
  store(cacheKey, { t: Date.now(), d });
  return d;
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

// ---------- Datenquellen ----------
function gsUrl(dataset, params, lat, lon) {
  return `${GS}/${dataset}?parameters=${params.join(',')}&lat_lon=${lat.toFixed(4)},${lon.toFixed(4)}&output_format=geojson`;
}

// GeoSphere-GeoJSON → { ts(ms): {param: value} }
function parseGeoSphere(json) {
  const out = new Map();
  const ts = json.timestamps || [];
  const params = json.features?.[0]?.properties?.parameters || {};
  ts.forEach((t, i) => {
    const row = {};
    for (const [k, v] of Object.entries(params)) row[k] = v.data?.[i];
    out.set(Date.parse(t), row);
  });
  return { rows: out, ref: json.reference_time };
}

async function fetchGeoSphere(lat, lon) {
  const k = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const ttl = 10 * 60e3;
  const jobs = {
    nwp: cachedJson('gs-nwp-' + k, ttl, gsUrl('nwp-v2-1h-1km', ['2t', 'tp', 'rain', 'sf', 'tcc', '10u', '10v', '10fg'], lat, lon)),
    ens: cachedJson('gs-ens-' + k, ttl, gsUrl('ensemble-v2-1h-1km', ['tp_p10', 'tp_p50', 'tp_p90', '2t_p10', '2t_p90'], lat, lon)),
    now: cachedJson('gs-now-' + k, 5 * 60e3, gsUrl('nowcast-v1-15min-1km', ['rr', 't2m', 'pt'], lat, lon)),
  };
  const res = {};
  const errors = {};
  await Promise.all(Object.entries(jobs).map(async ([name, p]) => {
    try {
      const parsed = parseGeoSphere(await p);
      if (parsed.rows.size) res[name] = parsed;
      else errors[name] = 'keine Daten für diesen Ort';
    } catch (e) { errors[name] = e.message; }
  }));
  return { res, errors };
}

// Open-Meteo Ensemble (DWD ICON-D2-EPS, 20 Läufe, 2 km): kostenlos, ohne Key.
// Pro Stunde: Anteil der Läufe mit >= 0,1 mm = Wahrscheinlichkeit; Median-Menge; Mittelwerte für Rest.
async function fetchOpenMeteo(lat, lon) {
  const vars = ['precipitation', 'temperature_2m', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m'];
  const url = `${OM}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${vars.join(',')}` +
    '&models=icon_d2_eps&forecast_days=3&timezone=GMT&wind_speed_unit=ms';
  try {
    const json = await cachedJson(`om-${lat.toFixed(3)},${lon.toFixed(3)}`, 15 * 60e3, url);
    if (json.error) throw new Error(json.reason || 'Fehler');
    const h = json.hourly || {};
    const members = (name) => Object.keys(h).filter((k) => k === name || k.startsWith(name + '_member'));
    const pk = members('precipitation');
    const rows = new Map();
    (h.time || []).forEach((t, i) => {
      const prec = pk.map((k) => h[k][i]).filter(isNum).sort((a, b) => a - b);
      if (!prec.length) return;
      const at = (name) => avg(members(name).map((k) => h[k][i]));
      rows.set(Date.parse(t + 'Z'), {
        prob: 100 * prec.filter((x) => x >= THRESHOLD_MM).length / prec.length,
        n: prec.length,
        mm: prec[Math.floor(prec.length / 2)],
        temp: at('temperature_2m'), cloud: at('cloud_cover'), wind: at('wind_speed_10m'), gust: at('wind_gusts_10m'),
      });
    });
    if (!rows.size) throw new Error('keine Daten für diesen Ort');
    return { rows };
  } catch (e) {
    return { error: e.status === 429 ? 'Tageslimit erreicht, später erneut' : e.message };
  }
}

// ---------- Wahrscheinlichkeits-Rechnung ----------
// P(Niederschlag > thr) aus Ensemble-Perzentilen (10/50/90) durch stückweise lineare Interpolation.
function probFromPercentiles(p10, p50, p90, thr = THRESHOLD_MM) {
  if (![p10, p50, p90].every(isNum)) return null;
  if (thr <= p10) return 90 + 10 * (1 - thr / Math.max(p10, 1e-9));
  if (thr <= p50) return 90 - 40 * (thr - p10) / Math.max(p50 - p10, 1e-9);
  if (thr <= p90) return 50 - 40 * (thr - p50) / Math.max(p90 - p50, 1e-9);
  return 10 * clamp(p90 / thr, 0, 1);       // oberes Ende: nur noch wenige Läufe nass
}

// Deterministische Menge → weiche Wahrscheinlichkeit (0,02 mm ≈ 0 %, ≥0,4 mm ≈ 100 %).
function probFromAmount(mm) {
  if (!isNum(mm)) return null;
  const x = clamp((mm - 0.02) / (0.4 - 0.02), 0, 1);
  return 100 * x * x * (3 - 2 * x);
}

function combine(parts) {
  let wsum = 0, sum = 0;
  for (const { p, w } of parts) if (isNum(p) && w > 0) { sum += p * w; wsum += w; }
  return wsum ? sum / wsum : null;
}

// ---------- Sonnenstand (für Tag/Nacht-Symbol) ----------
function sunUp(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400e3 - 10957.5;            // Tage seit J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  const alt = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return alt > -0.833 * rad;
}

function symbol(h) {
  const { prob, mm, snow, cloud, day } = h;
  if (isNum(prob) && prob >= 50 && isNum(mm) && mm >= THRESHOLD_MM) {
    if (snow) return ['🌨️', mm >= 1 ? 'Schneefall' : 'leichter Schneefall'];
    return mm >= 2 ? ['🌧️', 'kräftiger Regen'] : ['🌦️', 'Regen'];
  }
  if (isNum(prob) && prob >= 30) return [snow ? '🌨️' : '🌦️', snow ? 'evtl. Schnee' : 'evtl. Schauer'];
  if (!isNum(cloud)) return ['·', ''];
  if (cloud < 20) return [day ? '☀️' : '🌙', day ? 'sonnig' : 'klar'];
  if (cloud < 50) return [day ? '🌤️' : '🌙', 'leicht bewölkt'];
  if (cloud < 85) return [day ? '⛅' : '☁️', 'wolkig'];
  return ['☁️', 'bedeckt'];
}

// ---------- Zusammenführen ----------
function buildHours(pos, gs, om) {
  const now = Date.now();
  const startHour = Math.ceil(now / HOUR) * HOUR;                 // nächste volle Stunde (Ende der laufenden Stunde)
  const nwp = gs.res.nwp?.rows || new Map();
  const ens = gs.res.ens?.rows || new Map();
  const omr = om.rows || new Map();

  // Nowcast (15-min-Summen, Intervall endet am Zeitstempel) auf Stunden aufsummieren.
  const nowHourly = new Map();
  for (const [t, r] of (gs.res.now?.rows || new Map())) {
    const hk = Math.ceil(t / HOUR) * HOUR;
    const o = nowHourly.get(hk) || { mm: 0, n: 0, t2m: [] };
    if (isNum(r.rr)) { o.mm += r.rr; o.n++; }
    if (isNum(r.t2m)) o.t2m.push(r.t2m);
    nowHourly.set(hk, o);
  }

  const hours = [];
  for (let i = 0; i < HOURS_SHOWN; i++) {
    const t = startHour + i * HOUR;
    const n = nwp.get(t) || {}, e = ens.get(t) || {}, o = omr.get(t) || {};
    const nc = nowHourly.get(t);
    const nowcastMm = nc && nc.n >= 3 ? nc.mm * 4 / nc.n : null;   // auf volle Stunde hochrechnen, falls unvollständig

    const pEns = probFromPercentiles(e.tp_p10, e.tp_p50, e.tp_p90);
    const pNwp = probFromAmount(n.tp);
    const pOm = isNum(o.prob) ? o.prob : null;
    const pNc = probFromAmount(nowcastMm);
    const lead = (t - now) / HOUR;
    const wNc = isNum(pNc) ? clamp(1 - (lead - 1) / NOWCAST_HOURS, 0, 1) * 0.7 : 0;

    const pModels = combine([{ p: pEns, w: WEIGHTS.ens }, { p: pNwp, w: WEIGHTS.nwp }, { p: pOm, w: WEIGHTS.om }]);
    const prob = combine([{ p: pModels, w: isNum(pModels) ? 1 - wNc : 0 }, { p: pNc, w: wNc }]);

    const mmModels = avg([n.tp, o.mm, e.tp_p50]);
    const mm = wNc && isNum(nowcastMm) ? wNc * nowcastMm + (1 - wNc) * (mmModels ?? nowcastMm) : mmModels;

    const temp = avg([n['2t'], o.temp, nc ? avg(nc.t2m) : null]);
    const windN = isNum(n['10u']) && isNum(n['10v']) ? Math.hypot(n['10u'], n['10v']) : null;
    const wind = avg([windN, o.wind]);
    const gust = avg([n['10fg'], o.gust]);
    const cloud = avg([n.tcc, o.cloud]);
    const snow = isNum(n.sf) && isNum(n.rain) ? n.sf > n.rain : (isNum(temp) && temp < 0.5);
    const day = sunUp(new Date(t - HOUR / 2), pos.lat, pos.lon);

    const h = {
      t, prob, mm, temp, wind, gust, cloud, snow, day,
      tLo: e['2t_p10'], tHi: e['2t_p90'],
      src: { pEns, pNwp, pOm, omN: o.n, pNc, wNc, nwpMm: n.tp, omMm: o.mm, ens: [e.tp_p10, e.tp_p50, e.tp_p90], nowcastMm },
    };
    [h.icon, h.desc] = symbol(h);
    if ([prob, temp, cloud].some(isNum)) hours.push(h);
  }
  return hours;
}

// ---------- Darstellung ----------
const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'long', day: 'numeric', month: 'numeric' });
const wdFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'short' });

function renderNow(hours) {
  const h = hours[0];
  if (!h) return;
  $('nowIcon').textContent = h.icon;
  $('nowTemp').textContent = isNum(h.temp) ? `${fmt1(h.temp)}°` : '–';
  const range = isNum(h.tLo) && isNum(h.tHi) ? ` · Spanne ${fmt0(h.tLo)}…${fmt0(h.tHi)}°` : '';
  const wind = isNum(h.wind) ? ` · Wind ${fmt0(h.wind * 3.6)} km/h` + (isNum(h.gust) ? `, Böen ${fmt0(h.gust * 3.6)}` : '') : '';
  $('nowDesc').textContent = (h.desc || '') + range + wind;
  $('nowProb').textContent = isNum(h.prob) ? `${fmt0(h.prob)} %` : '–';
  const next6 = hours.slice(0, 6).map((x) => x.prob).filter(isNum);
  const max6 = next6.length ? Math.max(...next6) : null;
  $('nowProbText').textContent = 'Regen in der nächsten Stunde' + (isNum(max6) ? ` · max. ${fmt0(max6)} % in 6 h` : '');
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
  card.querySelector('h2 .muted').textContent = total < 0.05 ? '(trocken laut Radar-Hochrechnung)' : `(${fmt1(total)} mm laut Radar-Hochrechnung)`;
}

function renderDays(hours) {
  const byDay = new Map();
  for (const h of hours) {
    const key = new Date(h.t).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(h);
  }
  $('days').innerHTML = [...byDay.values()].slice(0, 3).map((hs) => {
    const temps = hs.map((h) => h.temp).filter(isNum);
    const probs = hs.map((h) => h.prob).filter(isNum);
    // Wahrscheinlichkeit für "irgendwann Regen" = 1 - Π(1-p) wäre zu hoch (Stunden sind korreliert) → Maximum.
    const pmax = probs.length ? Math.max(...probs) : null;
    const sum = hs.reduce((s, h) => s + (isNum(h.mm) ? h.mm : 0), 0);
    const rep = hs.reduce((a, b) => ((b.prob ?? 0) > (a.prob ?? 0) ? b : a), hs[Math.floor(hs.length / 2)]);
    const dayIcon = symbol(Object.assign({}, rep, { day: true }))[0];
    const d = new Date(hs[0].t);
    const name = d.toDateString() === new Date().toDateString() ? 'Heute' : wdFmt.format(d);
    return `<div class="day"><div>${name}</div><div class="i">${dayIcon}</div>
      <div>${temps.length ? `${fmt0(Math.min(...temps))}° / ${fmt0(Math.max(...temps))}°` : '–'}</div>
      <div class="p">${isNum(pmax) ? fmt0(pmax) + ' %' : '–'}</div>
      <div class="muted">${fmt1(sum)} mm</div></div>`;
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
      isNum(s.pEns) ? `Ensemble ${fmt0(s.pEns)} % (P10/50/90: ${s.ens.map(fmt1).join(' / ')} mm)` : 'Ensemble –',
      isNum(s.pNwp) ? `GeoSphere ${fmt0(s.pNwp)} % (${fmt1(s.nwpMm)} mm)` : 'GeoSphere –',
      isNum(s.pOm) ? `ICON-D2 ${fmt0(s.pOm)} % (${Math.round(s.pOm * s.omN / 100)} von ${s.omN} Läufen, Median ${fmt1(s.omMm)} mm)` : 'ICON-D2 –',
    ].filter(Boolean);
    html.push(`<tr class="h" data-t="${h.t}">
      <td class="t">${timeFmt.format(d)}</td>
      <td class="i" title="${h.desc}">${h.icon}</td>
      <td class="tmp">${isNum(h.temp) ? fmt0(h.temp) + '°' : '–'}</td>
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
    const name = s.placeName || (pos.fixed ? 'Fester Standort' : 'Mein Standort');
    $('place').textContent = `${name} · ${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` +
      (pos.acc ? ` (±${Math.round(pos.acc)} m)` : '') + (pos.stale ? ' · letzter bekannter' : '');

    setStatus(['Lade GeoSphere und Open-Meteo …']);
    const [gs, om] = await Promise.all([fetchGeoSphere(pos.lat, pos.lon), fetchOpenMeteo(pos.lat, pos.lon)]);
    const hours = buildHours(pos, gs, om);

    const names = { nwp: 'GeoSphere-Modell', ens: 'GeoSphere-Ensemble', now: 'Nowcast' };
    const msgs = [];
    const ok = Object.keys(gs.res).map((k) => names[k]);
    if (om.rows) ok.push('ICON-D2-Ensemble');
    msgs.push(`Stand ${timeFmt.format(new Date())} · Quellen: ${ok.join(', ') || 'keine'}`);
    for (const [k, e] of Object.entries(gs.errors)) msgs.push(`<span class="warn">${names[k]}: ${e}</span>`);
    if (om.error) msgs.push(`<span class="warn">Open-Meteo: ${om.error}</span>`);

    if (!hours.length) throw new Error('Keine Vorhersagedaten für diesen Ort (GeoSphere deckt Mitteleuropa ab).');
    renderNow(hours);
    renderNowcast(gs);
    renderDays(hours);
    renderHours(hours);
    setStatus(msgs);
  } catch (e) {
    setStatus([`<span class="err">${e.message}</span>`]);
  } finally {
    busy = false;
  }
}

// ---------- Einstellungen ----------
$('btnSettings').addEventListener('click', () => {
  const s = settings();
  $('fixLat').value = s.fixLat; $('fixLon').value = s.fixLon; $('placeName').value = s.placeName;
  $('settings').showModal();
});
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
    const next = {
    fixLat: $('fixLat').value.trim(),
    fixLon: $('fixLon').value.trim(), placeName: $('placeName').value.trim(),
  };
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
