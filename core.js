'use strict';
// Gemeinsamer Kern: läuft im Browser (app.js) und in Node (Benachrichtigung).

// ---------- Konfiguration ----------
const GS = 'https://dataset.api.hub.geosphere.at/v1/timeseries/forecast';
const OM = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const THRESHOLD_MM = 0.1;            // "es regnet" ab 0,1 mm pro Stunde
const WEIGHTS = { ens: 0.4, nwp: 0.2, om: 0.4 };
const NOWCAST_HOURS = 3;             // Nowcast-Einfluss klingt bis hierhin linear aus
const HOURS_SHOWN = 48;
const HOUR = 3600e3;

// ---------- kleine Helfer ----------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const avg = (arr) => { const v = arr.filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fmt1 = (x) => isNum(x) ? x.toLocaleString('de-AT', { maximumFractionDigits: 1 }) : '–';
const fmt0 = (x) => isNum(x) ? Math.round(x).toString() : '–';

function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
function load(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
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

// ---------- Kleidung fürs Radfahren ----------
const RIDE_KMH = 20;   // Fahrtwind: Eigengeschwindigkeit, die zum Wind dazukommt

// Gefühlte Temperatur auf dem Rad (Windchill-Formel mit Wind + Fahrtwind; über 10 °C gilt die Lufttemperatur).
function rideFeel(temp, windMs) {
  if (!isNum(temp)) return null;
  const v = (isNum(windMs) ? windMs * 3.6 : 0) + RIDE_KMH;
  if (temp > 10) return temp - Math.min(3, v / 15);
  const p = Math.pow(v, 0.16);
  return 13.12 + 0.6215 * temp - 11.37 * p + 0.3965 * temp * p;
}

// hours: Stunden-Objekte aus buildHours für den gewünschten Zeitraum.
function clothing(hours) {
  const hs = hours.filter((h) => isNum(h.temp));
  if (!hs.length) return null;
  const feels = hs.map((h) => rideFeel(h.temp, h.wind)).filter(isNum);
  const fMin = Math.min(...feels), fMax = Math.max(...feels);
  const tMin = Math.min(...hs.map((h) => h.temp)), tMax = Math.max(...hs.map((h) => h.temp));
  const probs = hs.map((h) => h.prob).filter(isNum);
  const pMax = probs.length ? Math.max(...probs) : 0;
  const mmSum = hs.reduce((s, h) => s + (isNum(h.mm) ? h.mm : 0), 0);
  const gusts = hs.map((h) => h.gust).filter(isNum);
  const gustKmh = gusts.length ? Math.max(...gusts) * 3.6 : null;
  const snowy = hs.some((h) => h.snow && (h.prob ?? 0) >= 30);
  const dark = hs.some((h) => !h.day);

  const items = [];
  // Hände
  if (fMin < -8) items.push(['🧤', 'Dicke Winterhandschuhe (Lobster/Fäustlinge)']);
  else if (fMin < 2) items.push(['🧤', 'Winterhandschuhe']);
  else if (fMin < 10) items.push(['🧤', 'Dünne Langfinger-Handschuhe']);
  // Kopf
  if (fMin < -8) items.push(['🧣', 'Sturmhaube oder Mütze + Buff/Halstuch']);
  else if (fMin < 2) items.push(['🧢', 'Mütze unter dem Helm + Buff']);
  else if (fMin < 8) items.push(['🧢', 'Stirnband / Ohrenschutz']);
  // Oberkörper
  if (fMin < 3) items.push(['🧥', 'Winterjacke (winddicht) + warme Unterschicht']);
  else if (fMin < 10) items.push(['🧥', 'Softshell- oder Thermojacke']);
  else if (fMin < 16) items.push(['👕', 'Langarm + Windweste']);
  else if (fMin < 21) items.push(['👕', 'Kurzarm + Armlinge']);
  else items.push(['👕', 'Kurzarm']);
  // Beine
  if (fMin < 5) items.push(['👖', 'Lange Thermohose']);
  else if (fMin < 14) items.push(['👖', 'Lange Hose / Beinlinge']);
  else if (fMin < 18) items.push(['🩳', 'Knielinge oder kurze Hose']);
  else items.push(['🩳', 'Kurze Hose']);
  // Füße
  if (fMin < 0) items.push(['🧦', 'Winterschuhe oder Neopren-Überschuhe + warme Socken']);
  else if (fMin < 6) items.push(['🧦', 'Überschuhe / warme Socken']);
  // Regen
  if (pMax >= 60 || mmSum >= 1) items.push(['🌧️', 'Regenjacke + Regenhose' + (fMin < 10 ? ' + wasserdichte Überschuhe' : '') + ' anziehen']);
  else if (pMax >= 30) items.push(['☂️', 'Regenjacke einpacken']);
  // Licht
  if (dark) items.push(['💡', 'Licht + Reflektoren (Dunkelheit)']);
  // Zwiebelprinzip
  if (fMax - fMin >= 8) items.push(['🧅', `Zwiebelprinzip: ${fmt0(tMin)}° bis ${fmt0(tMax)}° – Schicht zum Ausziehen`]);

  const warnings = [];
  if (tMin <= 1 && (pMax >= 30 || hs.some((h) => isNum(h.temp) && h.temp <= 0))) warnings.push('⚠️ Glättegefahr möglich');
  if (snowy) warnings.push('❄️ Schneefall möglich');
  if (isNum(gustKmh) && gustKmh >= 50) warnings.push(`💨 Sturmböen bis ${fmt0(gustKmh)} km/h`);
  else if (isNum(gustKmh) && gustKmh >= 35) warnings.push(`💨 Böen bis ${fmt0(gustKmh)} km/h`);

  const summary = `${fmt0(tMin)}° bis ${fmt0(tMax)}° (gefühlt am Rad ${fmt0(fMin)}°), Regen max. ${fmt0(pMax)} %` +
    (mmSum >= 0.1 ? `, ${fmt1(mmSum)} mm` : '');
  return { items, warnings, summary, tMin, tMax, fMin, pMax, mmSum };
}

if (typeof module !== 'undefined') {
  module.exports = { fetchGeoSphere, fetchOpenMeteo, buildHours, clothing, rideFeel, probFromPercentiles, HOUR, isNum, fmt0, fmt1 };
}
