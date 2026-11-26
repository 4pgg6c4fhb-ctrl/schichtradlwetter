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
    nwp: cachedJson('gs-nwp2-' + k, ttl, gsUrl('nwp-v2-1h-1km', ['2t', '2r', 'tp', 'rain', 'sf', 'tcc', '10u', '10v', '10fg'], lat, lon)),
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

// Open-Meteo Ensemble-API: kostenlos, ohne Key. Pro Stunde werden die Mengen aller Läufe gespeichert,
// damit sich beliebige Schwellen (0,1 mm „nass“, x mm „zu stark zum Radeln“) auszählen lassen.
//  - icon_d2_eps: DWD ICON-D2, 20 Läufe, 2 km, ~2 Tage
//  - ecmwf_ifs025: ECMWF, 51 Läufe, 25 km, 12 Tage (für die Schichten weiter voraus)
async function fetchEnsemble(model, days, ttlMs, lat, lon) {
  const vars = ['precipitation', 'snowfall', 'temperature_2m', 'relative_humidity_2m', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m'];
  const url = `${OM}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${vars.join(',')}` +
    `&models=${model}&forecast_days=${days}&timezone=GMT&wind_speed_unit=ms`;
  try {
    const json = await cachedJson(`om3-${model}-${lat.toFixed(3)},${lon.toFixed(3)}`, ttlMs, url);
    if (json.error) throw new Error(json.reason || 'Fehler');
    const h = json.hourly || {};
    const members = (name) => Object.keys(h).filter((k) => k === name || k.startsWith(name + '_member'));
    const pk = members('precipitation');
    const sk = members('snowfall');
    const times = h.time || [];
    const rows = new Map();
    times.forEach((t, i) => {
      const prec = pk.map((k) => h[k][i]).filter(isNum).sort((a, b) => a - b);
      if (!prec.length) return;
      // 3-h-Summe je Lauf (Stunde davor, diese, danach): grobe Modelle verschmieren Schauer über mehrere Stunden.
      const prec3 = pk.map((k) => [h[k][i - 1], h[k][i], h[k][i + 1]].filter(isNum).reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
      const at = (name) => avg(members(name).map((k) => h[k][i]));
      rows.set(Date.parse(t + 'Z'), {
        prec, prec3, n: prec.length, mm: prec[Math.floor(prec.length / 2)],
        snowM: sk.map((k) => h[k][i]),        // Neuschnee in cm je Lauf (Reihenfolge = Lauf)
        temp: at('temperature_2m'), rh: at('relative_humidity_2m'), cloud: at('cloud_cover'), wind: at('wind_speed_10m'), gust: at('wind_gusts_10m'),
      });
    });
    if (!rows.size) throw new Error('keine Daten für diesen Ort');
    return { rows };
  } catch (e) {
    return { error: e.status === 429 ? 'Tageslimit erreicht, später erneut' : e.message };
  }
}
const fetchOpenMeteo = (lat, lon) => fetchEnsemble('icon_d2_eps', 3, 15 * 60e3, lat, lon);
const fetchEcmwf = (lat, lon) => fetchEnsemble('ecmwf_ifs025', 12, 60 * 60e3, lat, lon);

// Anteil (%) der Werte >= thr
const fracAbove = (arr, thr) => (arr && arr.length ? 100 * arr.filter((x) => x >= thr).length / arr.length : null);

// ---------- Wahrscheinlichkeits-Rechnung ----------
// P(Niederschlag > thr) aus Ensemble-Perzentilen (10/50/90) durch stückweise lineare Interpolation.
function probFromPercentiles(p10, p50, p90, thr = THRESHOLD_MM) {
  if (![p10, p50, p90].every(isNum)) return null;
  if (thr <= p10) return 90 + 10 * (1 - thr / Math.max(p10, 1e-9));
  if (thr <= p50) return 90 - 40 * (thr - p10) / Math.max(p50 - p10, 1e-9);
  if (thr <= p90) return 50 - 40 * (thr - p50) / Math.max(p90 - p50, 1e-9);
  return 10 * clamp(p90 / thr, 0, 1);       // oberes Ende: nur noch wenige Läufe nass
}

// Deterministische Menge → weiche Wahrscheinlichkeit (unter lo ≈ 0 %, über hi ≈ 100 %).
function probFromAmount(mm, lo = 0.02, hi = 0.4) {
  if (!isNum(mm)) return null;
  const x = clamp((mm - lo) / (hi - lo), 0, 1);
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
// opts.heavyMm: ab dieser Menge pro Stunde wird nicht geradelt. opts.hours: wie viele Stunden ab jetzt.
function buildHours(pos, gs, om, ecm, opts = {}) {
  const heavy = opts.heavyMm || 2;
  const count = opts.hours || HOURS_SHOWN;
  const now = Date.now();
  const startHour = Math.ceil(now / HOUR) * HOUR;                 // nächste volle Stunde (Ende der laufenden Stunde)
  const nwp = gs.res.nwp?.rows || new Map();
  const ens = gs.res.ens?.rows || new Map();
  const omr = om.rows || new Map();
  const ecr = ecm?.rows || new Map();

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
  for (let i = 0; i < count; i++) {
    const t = startHour + i * HOUR;
    const n = nwp.get(t) || {}, e = ens.get(t) || {}, o = omr.get(t) || {}, x = ecr.get(t);
    const nc = nowHourly.get(t);
    const nowcastMm = nc && nc.n >= 2 ? nc.mm * 4 / nc.n : null;   // auf volle Stunde hochrechnen, falls unvollständig
    const lead = (t - now) / HOUR;
    const day = sunUp(new Date(t - HOUR / 2), pos.lat, pos.lon);

    const pEns = probFromPercentiles(e.tp_p10, e.tp_p50, e.tp_p90);
    const pNwp = probFromAmount(n.tp);
    const pOm = fracAbove(o.prec, THRESHOLD_MM);
    let h;

    if ([pEns, pNwp, pOm].some(isNum)) {
      // Kurzfrist: GeoSphere + ICON-D2 (+ Nowcast)
      const pNc = probFromAmount(nowcastMm);
      const wNc = isNum(pNc) ? clamp(1 - (lead - 1) / NOWCAST_HOURS, 0, 1) * 0.7 : 0;
      const mix = (a, b, c, d) => {
        const m = combine([{ p: a, w: WEIGHTS.ens }, { p: b, w: WEIGHTS.nwp }, { p: c, w: WEIGHTS.om }]);
        return combine([{ p: m, w: isNum(m) ? 1 - wNc : 0 }, { p: d, w: wNc }]);
      };
      const prob = mix(pEns, pNwp, pOm, pNc);
      const pHeavy = mix(probFromPercentiles(e.tp_p10, e.tp_p50, e.tp_p90, heavy),
        probFromAmount(n.tp, heavy * 0.5, heavy * 1.5), fracAbove(o.prec, heavy),
        probFromAmount(nowcastMm, heavy * 0.5, heavy * 1.5));

      const mmModels = avg([n.tp, o.mm, e.tp_p50]);
      const mm = wNc && isNum(nowcastMm) ? wNc * nowcastMm + (1 - wNc) * (mmModels ?? nowcastMm) : mmModels;
      const temp = avg([n['2t'], o.temp, nc ? avg(nc.t2m) : null]);
      const windN = isNum(n['10u']) && isNum(n['10v']) ? Math.hypot(n['10u'], n['10v']) : null;
      const wind = avg([windN, o.wind]);
      h = {
        t, prob, pHeavy, mm, temp, wind, day, range: 'kurz',
        rh: avg([n['2r'], o.rh]),
        gust: avg([n['10fg'], o.gust]),
        cloud: avg([n.tcc, o.cloud]),
        snow: isNum(n.sf) && isNum(n.rain) ? n.sf > n.rain : (isNum(temp) && temp < 0.5),
        tLo: e['2t_p10'], tHi: e['2t_p90'],
        src: { pEns, pNwp, pOm, omN: o.n, pNc, wNc, nwpMm: n.tp, omMm: o.mm, ens: [e.tp_p10, e.tp_p50, e.tp_p90], nowcastMm },
      };
    } else if (x) {
      // Langfrist: ECMWF-Ensemble (grob, Trend)
      h = {
        t, prob: fracAbove(x.prec, THRESHOLD_MM), pHeavy: fracAbove(x.prec3, heavy * 1.5),
        mm: x.mm, temp: x.temp, rh: x.rh, wind: x.wind, gust: x.gust, cloud: x.cloud, day, range: 'lang',
        snow: isNum(x.temp) && x.temp < 0.5,
        src: { pEcm: fracAbove(x.prec, THRESHOLD_MM), ecmN: x.n, ecmMm: x.mm },
      };
    } else continue;

    h.feel = rideFeel(h.temp, h.wind, opts.rideKmh);
    [h.icon, h.desc] = symbol(h);
    if ([h.prob, h.temp, h.cloud].some(isNum)) hours.push(h);
  }
  return hours;
}

// ---------- Kleidung fürs Radfahren ----------
const RIDE_KMH = 20;   // Fahrtwind: Eigengeschwindigkeit, die zum Wind dazukommt

// Gefühlte Temperatur auf dem Rad (Windchill-Formel mit Wind + Fahrtwind; über 10 °C gilt die Lufttemperatur).
function rideFeel(temp, windMs, rideKmh = RIDE_KMH) {
  if (!isNum(temp)) return null;
  const v = (isNum(windMs) ? windMs * 3.6 : 0) + rideKmh;
  if (temp > 10) return temp - Math.min(3, v / 15);
  const p = Math.pow(v, 0.16);
  return 13.12 + 0.6215 * temp - 11.37 * p + 0.3965 * temp * p;
}

// ---------- Schnee auf der Fahrbahn ----------
// Wahrscheinlichkeit (%), dass zwischen fromT und toT (Stunden-Endzeitpunkte, ms) mindestens thrCm Neuschnee fällt.
// Je Ensemble-Lauf wird der Schnee aufsummiert und gezählt; ICON-D2 bevorzugt, sonst ECMWF.
// GeoSphere-Hauptlauf (Schnee in mm Wasser ≈ cm Neuschnee) fließt mit 30 % ein, wenn er den Zeitraum abdeckt.
function snowRisk(fromT, toT, sources, thrCm) {
  const keys = [];
  for (let t = fromT + HOUR; t <= toT; t += HOUR) keys.push(t);
  const fromEns = (src) => {
    if (!src?.rows) return null;
    const rows = keys.map((k) => src.rows.get(k));
    if (rows.some((r) => !r || !r.snowM || !r.snowM.length)) return null;
    const n = rows[0].snowM.length;
    let hit = 0;
    for (let m = 0; m < n; m++) {
      const sum = rows.reduce((s, r) => s + (isNum(r.snowM[m]) ? r.snowM[m] : 0), 0);
      if (sum >= thrCm) hit++;
    }
    return 100 * hit / n;
  };
  let pEns = fromEns(sources.om), trend = false;
  if (!isNum(pEns)) { pEns = fromEns(sources.ecm); trend = isNum(pEns); }
  const nwp = sources.gs?.res?.nwp?.rows;
  let pNwp = null;
  if (nwp && keys.every((k) => nwp.has(k))) {
    const sum = keys.reduce((s, k) => s + (nwp.get(k).sf || 0), 0);
    pNwp = probFromAmount(sum, thrCm * 0.5, thrCm * 1.5);
  }
  const p = combine([{ p: pEns, w: 0.7 }, { p: pNwp, w: 0.3 }]);
  return { p, trend };
}

// ---------- Kleidung ----------
// prefs.levels: [{ below: 10, text }, { below: 15, text }, { below: 20, text }, { below: null, text }] – gefühlte Temperatur am Rad.
function outfit(feel, prefs) {
  for (const l of prefs.levels) if (l.below == null || feel < l.below) return l.text;
  return prefs.levels[prefs.levels.length - 1].text;
}

// Glätte braucht Feuchtigkeit – trockene Kälte ist nicht glatt.
//  - nasse Fahrbahn bei Frost: Niederschlag jetzt oder in den 6 h davor (>= 50 %) und Luft <= 1 °C
//  - Reif: Frost + feuchte Luft (>= 92 %) bei klarem Himmel, oder Nebelreif (>= 97 %) bei <= -1 °C
function iceRisk(hs, prev) {
  const tMin = Math.min(...hs.map((h) => h.temp));
  if (!(tMin <= 1)) return null;
  const pNow = Math.max(0, ...hs.map((h) => h.prob).filter(isNum));
  const pBefore = Math.max(0, ...prev.map((h) => h.prob).filter(isNum));
  if (Math.max(pNow, pBefore) >= 50) return 'Glätte: nasse Fahrbahn bei Frost';
  const rh = Math.max(0, ...hs.map((h) => h.rh).filter(isNum));
  const cloud = Math.min(100, ...hs.map((h) => h.cloud).filter(isNum));
  if (tMin <= 0 && rh >= 92 && cloud < 50) return `Reifglätte möglich (Feuchte ${fmt0(rh)} %, klar)`;
  if (tMin <= -1 && rh >= 97) return `Reifglätte möglich (Feuchte ${fmt0(rh)} %)`;
  return null;
}

// Bewertung einer Fahrt: Stunden der Fahrt (+ 6 h davor für nasse Fahrbahn) + Schnee-Risiko → Ampel, Gründe, Kleidung.
function assessRide(hs, snow, prefs, prev = []) {
  hs = hs.filter((h) => isNum(h.temp));
  if (!hs.length) return null;
  const max = (k) => { const v = hs.map((h) => h[k]).filter(isNum); return v.length ? Math.max(...v) : null; };
  const fMin = Math.min(...hs.map((h) => h.feel).filter(isNum));
  const tMin = Math.min(...hs.map((h) => h.temp));
  const pMax = max('prob') ?? 0;
  const pHeavy = max('pHeavy') ?? 0;
  const pSnow = snow && isNum(snow.p) ? snow.p : 0;
  const gustKmh = isNum(max('gust')) ? max('gust') * 3.6 : null;
  const iceText = pSnow >= 25 ? null : iceRisk(hs, prev.filter((h) => isNum(h.temp)));
  const ice = !!iceText;
  const rh = max('rh');
  const storm = isNum(gustKmh) && gustKmh >= 60;

  const reasons = [];
  if (pSnow >= 25) reasons.push(pSnow >= 50 ? `Schneefahrbahn (${fmt0(pSnow)} %)` : `evtl. Schnee (${fmt0(pSnow)} %)`);
  if (pHeavy >= 25) reasons.push(pHeavy >= 50 ? `viel Regen (${fmt0(pHeavy)} %)` : `evtl. viel Regen (${fmt0(pHeavy)} %)`);
  if (ice) reasons.push(iceText);
  if (storm) reasons.push(`Sturmböen ${fmt0(gustKmh)} km/h`);

  let verdict = 'ok';
  if (reasons.length) verdict = 'warn';
  if (pHeavy >= 50 || pSnow >= 50) verdict = 'stop';

  let clothes = outfit(fMin, prefs);
  if (pMax >= 30 && verdict !== 'stop') clothes += ' + Regenjacke';
  return { verdict, reasons, clothes, fMin, tMin, pMax, pHeavy, pSnow, ice, iceText, rh, storm,
    trend: hs.some((h) => h.range === 'lang') || !!snow?.trend };
}
