'use strict';
// Oberfläche. Rechnungen und Datenquellen stehen in core.js.

const $ = (id) => document.getElementById(id);

function settings() {
  return Object.assign({ fixLat: '', fixLon: '', placeName: '' }, load('settings', {}));
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

function renderClothing(hours) {
  const c = clothing(hours.slice(0, 12));
  $('clothCard').hidden = !c;
  if (!c) return;
  $('clothSummary').textContent = c.summary;
  $('clothList').innerHTML = c.warnings.map((w) => `<li class="warn">${w}</li>`).join('') +
    c.items.map(([i, t]) => `<li>${i} ${t}</li>`).join('');
}

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
    renderClothing(hours);
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
