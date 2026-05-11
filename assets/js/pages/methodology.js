/**
 * pages/methodology.js — Methodology view
 *
 * The methodology view is mostly hand-written prose authored directly into
 * app.html. This module:
 *   1. Wires the in-page TOC scroll-spy so the active section highlights as the user scrolls.
 *   2. Renders a "loaded snapshot" tile grid under the static Evidence Used card.
 *   3. Renders the Evidence panel listing the underlying data with row counts pulled from the loaded store.
 */

import { registerView } from '../lib/router.js';
import { getStore } from '../data/store.js';
import { renderEvidencePanel } from '../ui/evidence.js';
import { buildEvidence } from '../helpers/evidenceModel.js';

let _initialised = false;

/**
 * Compute a small "loaded snapshot" block that surfaces fields the dashboard
 * doesn't otherwise expose anywhere (has_para_classification count, Para-prefixed
 * sport count, top_sports field availability). This makes the evidence panel
 * an honest fingerprint of the loaded data rather than just file row counts.
 */
function renderSnapshot() {
  const host = document.getElementById('methSnapshot');
  if (!host) return;
  const store = getStore();
  // True dual-program count = athletes who appear under BOTH Olympic and
  // Paralympic sport_type rows in participation. has_para_classification on
  // the athletes table flags Paralympic-classified athletes (different
  // definition; can include Paralympic-only athletes).
  const olyIds = new Set();
  const paraIds = new Set();
  for (const r of store.participation) {
    if (r.sport_type === 'Olympic')    olyIds.add(r.athlete_id);
    if (r.sport_type === 'Paralympic') paraIds.add(r.athlete_id);
  }
  let dualProgramAthletes = 0;
  for (const id of olyIds) if (paraIds.has(id)) dualProgramAthletes++;
  const paraClassified = store.athletes.filter((a) => a.has_para_classification === true || a.has_para_classification === 1).length;
  const sportNames = new Set(store.stateSportSummary.map((r) => r.sport));
  const paraPrefixedSports = [...sportNames].filter((s) => /^para\b/i.test(s)).length;
  const climateCovered = store.climate.length;
  const stateRows = store.stateSummary.length;
  const offMap = stateRows - 51;
  const hubsCount = store.hometownSummary.length;
  const dualProgramHubs = store.hometownSummary.filter((h) => (h.olympic_athletes || 0) > 0 && (h.paralympic_athletes || 0) > 0).length;

  host.innerHTML = `
    <div class="snapshot-grid">
      <div class="snapshot-tile"><div class="snapshot-num">${store.athletes.length.toLocaleString()}</div><div class="snapshot-lbl">Athletes loaded</div></div>
      <div class="snapshot-tile"><div class="snapshot-num">${dualProgramAthletes.toLocaleString()}</div><div class="snapshot-lbl">Dual-program athletes <span class="snapshot-sub">(Olympic ∩ Paralympic participation)</span></div></div>
      <div class="snapshot-tile"><div class="snapshot-num">${paraClassified.toLocaleString()}</div><div class="snapshot-lbl">Paralympic-classified <span class="snapshot-sub">(has_para_classification flag)</span></div></div>
      <div class="snapshot-tile"><div class="snapshot-num">${sportNames.size}</div><div class="snapshot-lbl">Distinct sport names <span class="snapshot-sub">(${paraPrefixedSports} Para-prefixed variants)</span></div></div>
      <div class="snapshot-tile"><div class="snapshot-num">${hubsCount.toLocaleString()}</div><div class="snapshot-lbl">Hometown hubs <span class="snapshot-sub">(${dualProgramHubs} dual-program)</span></div></div>
      <div class="snapshot-tile"><div class="snapshot-num">${stateRows}</div><div class="snapshot-lbl">State rows <span class="snapshot-sub">(${offMap > 0 ? `${offMap} off-map: VI` : 'all on map'})</span></div></div>
      <div class="snapshot-tile"><div class="snapshot-num">${climateCovered}</div><div class="snapshot-lbl">NOAA climate normals <span class="snapshot-sub">(DC, HI not in nClimDiv series)</span></div></div>
    </div>
    <p class="snapshot-note">Top sports are re-derived live from the participation rows so program and season filters always apply correctly.</p>
  `;
}

function renderEvidence() {
  const store = getStore();
  const list = [
    buildEvidence({
      files: ['athletes_clean.json'],
      fields: ['athlete_id','hometown_city','hometown_state','hometown_key','has_para_classification'],
      rowCount: store.athletes.length,
      notes: ['One row per athlete. No names, images, ages, heights, gender, or medals.'],
    }),
    buildEvidence({
      files: ['athlete_sports.json'],
      fields: ['athlete_id','sport','sport_type','season'],
      rowCount: store.athleteSports.length,
      notes: ['Athlete ↔ sport mapping. Multi-discipline athletes contribute multiple rows.'],
    }),
    buildEvidence({
      files: ['athlete_participation_clean.json'],
      fields: ['athlete_id','hometown_city','hometown_state','hometown_key','sport','sport_type','season','has_para_classification'],
      rowCount: store.participation.length,
      notes: ['Joined athlete + sport + hometown rows. Source of all filter-driven aggregates.'],
    }),
    buildEvidence({
      files: ['state_summary.json'],
      fields: ['state','total_athletes','olympic_athletes','paralympic_athletes','summer_athletes','winter_athletes','sport_count','top_sports','parity_ratio'],
      rowCount: store.stateSummary.length,
      notes: ['Pre-computed per-state aggregates used for KPIs and the choropleth.'],
    }),
    buildEvidence({
      files: ['state_sport_summary.json'],
      fields: ['state','sport','season','sport_type','athlete_count','participation_count'],
      rowCount: store.stateSportSummary.length,
      notes: ['Per-state × per-sport rows. Drives Sport Explorer and per-state sport rankings.'],
    }),
    buildEvidence({
      files: ['hometown_summary.json'],
      fields: ['hometown_city','hometown_state','hometown_key','total_athletes','olympic_athletes','paralympic_athletes','summer_athletes','winter_athletes','sport_count','top_sports','parity_ratio'],
      rowCount: store.hometownSummary.length,
      notes: ['Per-city aggregates. Hometown ≠ training location.'],
    }),
    buildEvidence({
      files: ['climate_state_summary.json'],
      fields: ['state','state_name','noaa_state_code','avg_annual_temp_f','avg_annual_precip_in','monthly_temp_*','monthly_precip_*'],
      rowCount: store.climate.length,
      notes: ['NOAA nClimDiv 1991–2020 normals. Descriptive context only — no causal claims.'],
    }),
    buildEvidence({
      files: ['hometown_geo.json'],
      fields: ['hometown_key','hometown_city','hometown_state','lat','lng','x','y'],
      rowCount: (store.hometownGeo || []).length,
      notes: ['City coordinates used to drop the top-10 hometown bubbles on the Atlas map. Lat/lng from public-domain GeoNames; SVG x/y precomputed against the basemap projection so the bubble overlay aligns with the state polygons. ~93% of hometowns have a coordinate; the unmatched ~7% are small places (1–4 athletes) that simply do not get a bubble.'],
    }),
  ];
  const host = document.getElementById('methEvidence');
  renderEvidencePanel(host, list);
}

function bindTocScrollSpy() {
  const links = Array.from(document.querySelectorAll('#methToc a'));
  if (!links.length) return;
  const targetFor = (a) => {
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('#')) return null;
    return document.querySelector(href);
  };
  const handler = () => {
    const targets = links.map(targetFor); // re-resolve each time (Evidence card is appended after first render)
    const probe = (window.scrollY || document.documentElement.scrollTop || 0) + 120;
    let activeIdx = 0;
    targets.forEach((t, i) => {
      if (!t) return;
      const rect = t.getBoundingClientRect();
      const absoluteTop = rect.top + (window.scrollY || 0);
      if (absoluteTop <= probe) activeIdx = i;
    });
    links.forEach((a, i) => a.classList.toggle('active', i === activeIdx));
  };
  window.addEventListener('scroll', handler, { passive: true });
  window.addEventListener('resize', handler, { passive: true });
  // Click on a TOC link should also reflect immediately.
  document.getElementById('methToc')?.addEventListener('click', () => {
    setTimeout(handler, 50);
  });
  handler();
}

registerView('methodology', () => {
  renderSnapshot();
  renderEvidence();
  if (!_initialised) {
    bindTocScrollSpy();
    _initialised = true;
  }
});
