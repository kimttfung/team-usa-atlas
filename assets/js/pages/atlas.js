/**
 * pages/atlas.js — Atlas Overview
 *
 * Wires the Atlas filterbar + map + national snapshot + selected-state panel
 * + sport / hub lists + climate context + locally-computed Regional Insight.
 *
 * State model (kept module-local, not exported):
 *   _state = {
 *     metric: 'total' | 'share' | 'diversity' | 'parity',
 *     program: 'both' | 'oly' | 'para',
 *     season:  'all'  | 'summer' | 'winter',
 *     sport:   'any'  | <sport name>,
 *     selectedState: null | <state code>
 *   }
 *
 * When sport != 'any', the metric collapses to "Athletes in {sport}" and we
 * compute the per-state map from state_sport_summary filtered by program/season
 * (instead of the precomputed state_summary totals). Diversity/parity metrics
 * are hidden in that mode (they don't apply within a single sport).
 */

import { registerView, setView, consumeViewParams, updateUrlState } from '../lib/router.js';
import { getStore, STATE_NAMES, PARITY_MIN_DENOMINATOR } from '../data/store.js';
import { getStateSummary, getStateClimate, getStateSports, getStateHometowns, getStateOptions } from '../helpers/states.js';
import { getAllSports, topStatesForSport } from '../helpers/sports.js';
import {
  getNationalTotal, getShareOfNational, getTopSports, getTopHometowns,
  getOlyParaSplit, getSummerWinterSplit,
  getStateSportTotals, getNationalSportTotals,
  getScopedStateTotals, getScopedNationalTotals,
  getStateAggregateMap, getTopHometownsScoped, getTopSportsScoped,
  getTopHometownBubbles, getHometownConcentration,
} from '../helpers/aggregates.js';
import { findSimilarStates } from '../helpers/similar.js';
import { getTopSportsForState } from '../helpers/topSports.js';
import { getAtlasContext } from '../helpers/context.js';
import { makeContextCacheKey } from '../helpers/cacheKey.js';
import { makeRegionalBrief } from '../helpers/responseSchemas.js';
import { getOrBuildContext } from '../helpers/contextCache.js';
import { generateInsight } from '../lib/gemini.js';
import { renderMap, renderLegendRamp } from '../ui/map.js';
import { renderTempChart, renderPrecipChart } from '../ui/miniCharts.js';
import { setText, fmtInt, fmtPct, fmtRatio } from '../ui/kpi.js';
import { attachCopyButton, htmlToPlainText } from '../ui/copyButton.js';
import { renderInsightSkeleton, renderInsightBody } from '../ui/insightSkeleton.js';

const _state = {
  metric: 'total',
  program: 'both',
  season: 'all',
  sport: 'any',
  selectedState: null,
};

let _initialised = false;
let _activeLens = null;
let _applyingLens = false;

// Guided exploration lenses. Each maps to the four Atlas filterbar selects.
// Lenses keep `metric: 'total'` for program/season-narrowed views; the
// program/season filters already restrict the population, so per-state totals
// already represent (e.g.) "Paralympic athletes" or "Winter athletes".
// Note: a "Hometown Clusters" lens used to live here as the first entry, but
// it was a no-op — every value matched the page defaults, so pressing it just
// turned the chip purple without changing the view. The default Atlas state
// is already the Hometown Clusters view, and the reset button restores it.
const ATLAS_LENSES = [
  { id: 'paralympic-rep',     label: 'Paralympic Representation',   metric: 'total',     program: 'para', season: 'all',    sport: 'any' },
  { id: 'winter-footprint',   label: 'Winter Footprint',            metric: 'total',     program: 'both', season: 'winter', sport: 'any' },
  { id: 'sport-diversity',    label: 'Sport Diversity',             metric: 'diversity', program: 'both', season: 'all',    sport: 'any' },
  { id: 'parity-balance',     label: 'Olympic / Paralympic Balance',metric: 'parity',    program: 'both', season: 'all',    sport: 'any' },
];

// ---------- Filter mappers (UI value → store value) ----------

function programFilter() {
  if (_state.program === 'oly')  return 'Olympic';
  if (_state.program === 'para') return 'Paralympic';
  return null;
}
function seasonFilter() {
  if (_state.season === 'summer') return 'Summer';
  if (_state.season === 'winter') return 'Winter';
  return null;
}

// ---------- Map metric computations ----------

const METRIC_LABEL = {
  total:     'Total Athletes',
  share:     'Share of National',
  diversity: 'Sport Diversity',
  parity:    'Paralympic Share',
};

function buildValueMap() {
  const store = getStore();
  const filters = activeFilters();

  // Sport selected → per-state athletes-in-sport from participation distinct
  // athlete IDs (so program/season filters layer cleanly with no double count).
  // When metric=share is also active, render share within the sport-scoped
  // national population so the choropleth and "Current View" stay consistent
  // (Current View's share branch uses the same sport-scoped national total).
  if (_state.sport !== 'any') {
    const aggMap = getStateAggregateMap(filters);
    if (_state.metric === 'share') {
      const nat = getScopedNationalTotals(filters).total;
      const map = {};
      for (const [st, a] of aggMap) map[st] = nat ? (a.total || 0) / nat : 0;
      return {
        valueByState: map,
        label: `Share of US athletes in ${_state.sport}`,
        format: (v) => v == null ? '—' : `${(v * 100).toFixed(2)}%`,
      };
    }
    const map = {};
    for (const [st, a] of aggMap) map[st] = a.total;
    return { valueByState: map, label: `Athletes in ${_state.sport}`, format: (v) => v == null ? '0' : Number(v).toLocaleString() };
  }

  // Sport diversity = distinct sports a state has athletes in under the
  // current program/season filter. Derived from per-state participation so the
  // map narrows consistently with every other metric. (Methodology's State
  // Diversity ranking uses unfiltered state_summary, which equals this when
  // no program/season is set.)
  if (_state.metric === 'diversity') {
    const aggMap = getStateAggregateMap(filters);
    const map = {};
    for (const [st, a] of aggMap) map[st] = a.sportCount || 0;
    return { valueByState: map, label: METRIC_LABEL.diversity, format: (v) => v == null ? '—' : `${v} sports` };
  }

  // For every other metric, derive from the per-state participation aggregate
  // so any combination of program + season + (no sport) honors all filters.
  const aggMap = getStateAggregateMap(filters);

  if (_state.metric === 'parity') {
    const map = {};
    for (const [st, a] of aggMap) map[st] = a.paralympicShare;
    return { valueByState: map, label: METRIC_LABEL.parity, format: (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%` };
  }
  if (_state.metric === 'share') {
    const nat = getScopedNationalTotals(filters).total;
    const map = {};
    for (const [st, a] of aggMap) map[st] = nat ? a.total / nat : 0;
    return { valueByState: map, label: METRIC_LABEL.share, format: (v) => v == null ? '—' : `${(v * 100).toFixed(2)}%` };
  }

  // Default: total athletes per state (still derived from per-state participation
  // aggregate so any combination of program + season honors all filters).
  const map = {};
  for (const [st, a] of aggMap) map[st] = a.total || 0;
  return { valueByState: map, label: METRIC_LABEL.total, format: (v) => v == null ? '0' : Number(v).toLocaleString() };
}

// ---------- DOM populators ----------

function populateSportSelect() {
  const sel = document.querySelector('#filterbar select[data-filter="sport"]');
  if (!sel) return;
  const sports = getAllSports();
  sel.innerHTML = '<option value="any" selected>Any Sport</option>' +
    sports.map((s) => `<option value="${s}">${s}</option>`).join('');
  sel.value = _state.sport;
}

function populateProgramSelect() {
  const sel = document.querySelector('#filterbar select[data-filter="program"]');
  if (!sel) return;
  const { PROGRAMS } = getStore();
  // 'both' = no filter; lowercase tags are kept stable for back-compat with the
  // existing _state machine that compares against 'oly'/'para'.
  const tag = (p) => p.toLowerCase().slice(0, 4); // Olympic→olym, Paralympic→para — adjust below
  const codeFor = (p) => p === 'Olympic' ? 'oly' : (p === 'Paralympic' ? 'para' : p.toLowerCase());
  sel.innerHTML = '<option value="both" selected>Both</option>' +
    PROGRAMS.map((p) => `<option value="${codeFor(p)}">${p} Only</option>`).join('');
  sel.value = _state.program;
}

function populateSeasonSelect() {
  const sel = document.querySelector('#filterbar select[data-filter="season"]');
  if (!sel) return;
  const { SEASONS } = getStore();
  sel.innerHTML = '<option value="all" selected>All Seasons</option>' +
    SEASONS.map((s) => `<option value="${s.toLowerCase()}">${s}</option>`).join('');
  sel.value = _state.season;
}

function syncMetricOptions() {
  const sel = document.querySelector('#filterbar select[data-filter="metric"]');
  if (!sel) return;
  const sportLocked = _state.sport !== 'any';
  // Paralympic Share is degenerate when a single program is selected:
  //   program=Olympic   → share is 0 everywhere (no Paralympic rows in scope)
  //   program=Paralympic→ share is 1 everywhere (all rows are Paralympic)
  // So disable it whenever program is locked. Sport-locked already collapses
  // the metric to "Athletes in {sport}", so diversity/parity are also hidden.
  const programLocked = _state.program === 'oly' || _state.program === 'para';
  Array.from(sel.options).forEach((opt) => {
    if (opt.value === 'diversity') {
      opt.hidden = sportLocked;
      opt.disabled = sportLocked;
    } else if (opt.value === 'parity') {
      opt.hidden = sportLocked || programLocked;
      opt.disabled = sportLocked || programLocked;
    }
  });
  if (sportLocked && (_state.metric === 'diversity' || _state.metric === 'parity')) {
    _state.metric = 'total';
    sel.value = 'total';
  }
  if (programLocked && _state.metric === 'parity') {
    _state.metric = 'total';
    sel.value = 'total';
  }
}

// ---------- National snapshot ----------

function activeFilters() {
  return {
    sport:   _state.sport === 'any' ? null : _state.sport,
    program: programFilter(),
    season:  seasonFilter(),
    metric:  _state.metric || null,
  };
}

function hasActiveFilter() {
  const f = activeFilters();
  return Boolean(f.sport || f.program || f.season);
}

// renderNationalSnapshot was removed — its values are now folded into the
// expanded "Current View" card via renderCurrentView().

// ---------- Top sports + hubs (national or state-scoped, possibly sport-pivoted) ----------

const FOLLOWUP_QUESTION_IDS = new Set([
  'top-states-athletes',
  'top-states-diversity',
  'top-states-paralympic',
  'most-balanced-parity',
  'top-hometown-hubs',
  'top-hometown-hubs-winter',
  'sports-broadest-state-coverage',
  'compare-ca-co',
  'high-counts-and-diversity',
  'high-winter-share',
]);

function sportScopeLabel() {
  const parts = [];
  if (_state.program === 'oly')    parts.push('Olympic');
  if (_state.program === 'para')   parts.push('Paralympic');
  if (_state.season  === 'summer') parts.push('Summer');
  if (_state.season  === 'winter') parts.push('Winter');
  return parts.join(' · ');
}

function renderSportList() {
  const host  = document.getElementById('sportList');
  const title = document.getElementById('sportListTitle');
  const meta  = document.getElementById('sportListMeta');
  if (!host) return;

  // Sport filter active → pivot to "Top States in {sport}"
  if (_state.sport !== 'any') {
    if (title) title.textContent = `Top States in ${_state.sport}`;
    if (meta)  meta.textContent  = sportScopeLabel() || 'all programs';
    const items = topStatesForSport(_state.sport, {
      program: programFilter(),
      season:  seasonFilter(),
      limit: 10,
    });
    if (!items.length) {
      host.innerHTML = `<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No states found for ${_state.sport} with the current filters.</div>`;
      return;
    }
    const max = Math.max(...items.map((it) => it.athletes || 0));
    const seasonClass = (_state.season === 'winter') ? 'season-winter' : 'season-summer';
    host.innerHTML = items.map((it) => {
      const pct = max ? ((it.athletes || 0) / max) * 100 : 0;
      return `
        <div class="sport-row" data-state="${it.state}">
          <div class="name">${it.name}</div>
          <div class="bar"><i class="${seasonClass}" style="width:${pct.toFixed(1)}%"></i></div>
          <div class="count">${fmtInt(it.athletes)}</div>
        </div>
      `;
    }).join('');
    return;
  }

  // Default: top sports nationally or for the selected state — honor active
  // program/season filters via getTopSportsScoped (distinct athletes per sport).
  const filters = activeFilters();
  if (title) title.textContent = _state.selectedState
    ? `Top 10 Sports · ${STATE_NAMES[_state.selectedState] || _state.selectedState}`
    : 'Top 10 Sports';
  if (meta) meta.textContent = sportScopeLabel() || '';
  const items = getTopSportsScoped(
    { state: _state.selectedState || null, program: filters.program, season: filters.season },
    10,
  );
  if (!items.length) { host.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No sport data.</div>'; return; }
  const max = Math.max(...items.map((it) => (it.athlete_count ?? it.athletes) || 0));
  host.innerHTML = items.map((it) => {
    const value = (it.athlete_count ?? it.athletes) || 0;
    const pct = max ? (value / max) * 100 : 0;
    const seasonClass = it.season === 'Winter' ? 'season-winter' : 'season-summer';
    return `
      <div class="sport-row">
        <div class="name">${it.sport}</div>
        <div class="bar"><i class="${seasonClass}" style="width:${pct.toFixed(1)}%"></i></div>
        <div class="count">${fmtInt(value)}</div>
      </div>
    `;
  }).join('');
}

function renderHubList(items) {
  const host  = document.getElementById('hubList');
  const title = document.getElementById('hubListTitle');
  const meta  = document.getElementById('hubListMeta');
  if (!host) return;

  const stateName = _state.selectedState ? (STATE_NAMES[_state.selectedState] || _state.selectedState) : null;
  let scopeLabel;

  if (_state.sport !== 'any') {
    scopeLabel = stateName
      ? `${stateName} · ${_state.sport}`
      : `${_state.sport}${sportScopeLabel() ? ' · ' + sportScopeLabel() : ''}`;
    if (title) title.textContent = stateName
      ? `Top Hubs · ${_state.sport}`
      : `Top 10 Hubs · ${_state.sport}`;
  } else {
    // No specific sport scope: show only the selected state's name (or
    // nothing at all when the page is at its default, all-states view).
    // The bare "Nationwide" label was redundant — the page title and the
    // un-filtered map already tell the user the scope is national.
    scopeLabel = (stateName || '')
      + (sportScopeLabel() ? `${stateName ? ' · ' : ''}${sportScopeLabel()}` : '');
    if (title) title.textContent = 'Top 10 Hometown Hubs';
  }

  if (meta) meta.textContent = scopeLabel;

  if (!items || !items.length) {
    host.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No hometown data.</div>';
    return;
  }
  host.innerHTML = items.map((it) => {
    const oly  = it.olympic_athletes || 0;
    const para = it.paralympic_athletes || 0;
    const total = it.total_athletes || (oly + para);
    const dots = [];
    if (oly  > 0) dots.push('<i class="oly" title="Olympic"></i>');
    if (para > 0) dots.push('<i class="para" title="Paralympic"></i>');
    return `
      <div class="hub-row" data-hometown="${it.hometown_key || ''}">
        <div class="city">${it.hometown_city}<span>${it.hometown_state}</span></div>
        <div class="ratio">${dots.join('')}</div>
        <div class="total">${fmtInt(total)}</div>
      </div>
    `;
  }).join('');
}

// ---------- Climate context ----------

function renderClimate() {
  const host = document.getElementById('climateBlock');
  if (!host) return;
  if (!_state.selectedState) {
    host.innerHTML = `
      <div class="climate-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
        </svg>
        <div>
          <div class="climate-empty__title">Select a state to see climate context</div>
          <div class="climate-empty__sub">NOAA 1991–2020 normals — annual + monthly temperature and precipitation. Descriptive context only.</div>
        </div>
      </div>
    `;
    return;
  }
  const climate = getStateClimate(_state.selectedState);
  if (!climate) {
    host.innerHTML = `
      <div class="climate-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><path d="M9 9h.01M15 9h.01M9 15h6"/>
        </svg>
        <div>
          <div class="climate-empty__title">No NOAA normals available</div>
          <div class="climate-empty__sub">${STATE_NAMES[_state.selectedState] || _state.selectedState} isn't covered by the NOAA nClimDiv state series used here.</div>
        </div>
      </div>
    `;
    return;
  }
  host.innerHTML = `
    <div class="climate-row"><span class="k">Avg annual temperature</span><span class="v">${climate.avg_annual_temp_f?.toFixed(1)} °F</span></div>
    <div class="climate-row"><span class="k">Annual precipitation</span><span class="v">${climate.avg_annual_precip_in?.toFixed(1)} in</span></div>
    <div class="climate-charts">
      <div class="climate-charts__cell">
        <div class="climate-charts__label">Monthly temperature (°F)</div>
        <div id="climateTemp"></div>
      </div>
      <div class="climate-charts__cell">
        <div class="climate-charts__label">Monthly precipitation (in)</div>
        <div id="climatePrecip"></div>
      </div>
    </div>
  `;
  renderTempChart('climateTemp', climate);
  renderPrecipChart('climatePrecip', climate);
}

// ---------- Selected state overview ----------

function renderStateOverview() {
  const eyebrow = document.getElementById('stateEyebrow');
  const name    = document.getElementById('stateName');
  const reset   = document.getElementById('resetStateBtn');
  const banner  = document.getElementById('stateScopeBanner');

  if (!_state.selectedState) {
    if (eyebrow) eyebrow.textContent = 'Nationwide';
    if (name)    name.textContent    = 'All States';
    if (reset)   reset.style.display = 'none';
    if (banner) {
      if (_state.sport !== 'any') {
        banner.style.display = '';
        banner.textContent = `Filtered · ${_state.sport}${sportScopeLabel() ? ' · ' + sportScopeLabel() : ''}`;
      } else {
        banner.style.display = 'none';
        banner.textContent = '';
      }
    }
    renderStateStats(null);
    renderStateSplit(null);
    renderStateSeasonSplit(null);
    return;
  }
  const code = _state.selectedState;
  const summary = getStateSummary(code);
  const stateName = STATE_NAMES[code] || code;
  if (eyebrow) eyebrow.textContent = `Selected · ${code}`;
  if (name)    name.textContent    = stateName;
  if (reset)   reset.style.display = '';
  if (banner) {
    if (_state.sport !== 'any') {
      banner.style.display = '';
      banner.textContent = `${stateName} · ${_state.sport}${sportScopeLabel() ? ' · ' + sportScopeLabel() : ''}`;
    } else {
      banner.style.display = 'none';
      banner.textContent = '';
    }
  }
  renderStateStats(summary);
  renderStateSplit(summary);
  renderStateSeasonSplit(summary);
}

function setStat(rowIdx, valueText) {
  // The state-stats block contains 4 stat cards in DOM order:
  //   0: Total Athletes  1: Share of National  2: Sport Diversity  3: Paralympic Share
  const stats = document.querySelectorAll('section.view[data-view="atlas"] .state-stats .stat');
  const row = stats[rowIdx];
  if (!row) return;
  const counter = row.querySelector('.counter');
  if (counter) counter.textContent = valueText;
}
function setStatDelta(rowIdx, deltaText) {
  const stats = document.querySelectorAll('section.view[data-view="atlas"] .state-stats .stat');
  const row = stats[rowIdx];
  if (!row) return;
  const delta = row.querySelector('.delta');
  if (delta) delta.innerHTML = deltaText;
}

function renderStateStats(summary) {
  const filters = activeFilters();
  const sportLocked = !!filters.sport;
  const programActive = !!filters.program;
  const seasonActive  = !!filters.season;
  const anyFilter = sportLocked || programActive || seasonActive;
  const scopeBits = [];
  if (filters.sport)   scopeBits.push(filters.sport);
  if (filters.program) scopeBits.push(filters.program);
  if (filters.season)  scopeBits.push(filters.season);
  const scopeSuffix = scopeBits.length ? ` · ${scopeBits.join(' · ')}` : '';
  const scopeNoun = filters.sport ? 'sport-filtered' : 'filtered';

  if (!summary) {
    // Nationwide. Even when no filter is active, route through the scoped
    // helper so the Paralympic-share tile uses the same definition as the
    // Aggregate Snapshot (709 / 4,705 = 15.1%) instead of the
    // has_para_classification count (617 / 4,705 = 13.1%).
    const nat = getScopedNationalTotals(filters);
    setStat(0, fmtInt(nat.total));
    setStatDelta(0, anyFilter ? `athletes${scopeSuffix}` : 'across the roster');
    setStat(1, '100%');
    setStatDelta(1, anyFilter ? `national subset${scopeSuffix}` : 'national aggregate');
    setStat(2, fmtInt(nat.sportCount));
    setStatDelta(2, anyFilter
      ? (sportLocked ? 'sport (filtered)' : 'sports in scope')
      : 'across all 50 states + DC');
    setStat(3, `${(nat.paralympicShare * 100).toFixed(1)}%`);
    setStatDelta(3, anyFilter
      ? `Paralympic share${scopeSuffix}`
      : `balance index <span class="mono">${fmtRatio(nat.balanceIndex, 2)}</span>`);
    return;
  }

  // Single state selected — always derive from participation so all four
  // tiles use the same definition under any filter combo (and 0 filter combo).
  const stTot = getScopedStateTotals(summary.state, filters);
  const natTot = getScopedNationalTotals(filters);
  setStat(0, fmtInt(stTot.total));
  setStatDelta(0, anyFilter ? `athletes${scopeSuffix}` : 'across the roster');
  const share = natTot.total ? stTot.total / natTot.total : 0;
  setStat(1, stTot.total ? `${(share * 100).toFixed(2)}%` : '—');
  setStatDelta(1, anyFilter ? `share of national${scopeSuffix}` : 'of all hometown athletes');
  setStat(2, stTot.total ? fmtInt(stTot.sportCount) : '—');
  setStatDelta(2, anyFilter
    ? (sportLocked ? 'sport (filtered)' : 'sports in scope')
    : 'distinct disciplines');
  setStat(3, stTot.total ? `${(stTot.paralympicShare * 100).toFixed(1)}%` : '—');
  setStatDelta(3, anyFilter
    ? `Paralympic share${scopeSuffix}`
    : `balance index <span class="mono">${fmtRatio(stTot.balanceIndex, 2)}</span>`);
}

function renderStateSplit(summary) {
  const olyEl  = document.getElementById('splitOly');
  const paraEl = document.getElementById('splitPara');
  const legOly = document.getElementById('legOly');
  const legPara = document.getElementById('legPara');
  const filters = activeFilters();
  // Always derive from scoped participation so program/season/sport filters all apply.
  const totals = summary
    ? getScopedStateTotals(summary.state, filters)
    : getScopedNationalTotals(filters);
  const oly  = totals.olympic;
  const para = totals.paralympic;
  const splitTotal = oly + para;
  if (olyEl)  olyEl.style.width  = splitTotal ? `${(oly  / splitTotal * 100).toFixed(1)}%` : '0%';
  if (paraEl) paraEl.style.width = splitTotal ? `${(para / splitTotal * 100).toFixed(1)}%` : '0%';
  if (legOly) legOly.textContent = fmtInt(oly);
  if (legPara) legPara.textContent = fmtInt(para);
}

function renderStateSeasonSplit(summary) {
  const sumEl  = document.getElementById('splitSummer');
  const winEl  = document.getElementById('splitWinter');
  const legSum = document.getElementById('legSummer');
  const legWin = document.getElementById('legWinter');
  const filters = activeFilters();
  const totals = summary
    ? getScopedStateTotals(summary.state, filters)
    : getScopedNationalTotals(filters);
  const summer = totals.summer;
  const winter = totals.winter;
  const splitTotal = summer + winter;
  if (sumEl) sumEl.style.width = splitTotal ? `${(summer / splitTotal * 100).toFixed(1)}%` : '0%';
  if (winEl) winEl.style.width = splitTotal ? `${(winter / splitTotal * 100).toFixed(1)}%` : '0%';
  if (legSum) legSum.textContent = fmtInt(summer);
  if (legWin) legWin.textContent = fmtInt(winter);
}

// ---------- Regional Insight (locally-computed brief) ----------

function buildBrief() {
  const filters = activeFilters();
  const anyFilter = !!(filters.sport || filters.program || filters.season);
  const scopeBits = [];
  if (filters.sport)   scopeBits.push(filters.sport);
  if (filters.program) scopeBits.push(filters.program);
  if (filters.season)  scopeBits.push(filters.season);
  const scopeSuffix = scopeBits.length ? ` · ${scopeBits.join(' · ')}` : '';

  const nat = getScopedNationalTotals(filters);
  const total = nat.total;

  if (!_state.selectedState) {
    // Find top-3 states under the active filter combo via per-state aggregate map
    const aggMap = getStateAggregateMap(filters);
    const top = Array.from(aggMap.values())
      .filter((a) => a.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);
    const distinctSports = nat.sportCount;
    const winterShare = total ? (nat.winter / total) : 0;
    const sections = [];
    if (top.length >= 3) {
      const topShare = total ? (top[0].total + top[1].total + top[2].total) / total : 0;
      sections.push({
        h: anyFilter ? `Snapshot${scopeSuffix}` : 'Snapshot',
        p: `The cleaned roster${anyFilter ? ' under this filter' : ''} spans <span class="accent">${fmtInt(total)}</span> athletes across <span class="accent">${distinctSports}</span> distinct sports. <span class="accent">${STATE_NAMES[top[0].state] || top[0].state}</span>, <span class="accent">${STATE_NAMES[top[1].state] || top[1].state}</span>, and <span class="accent">${STATE_NAMES[top[2].state] || top[2].state}</span> together represent roughly <span class="accent">${fmtPct(topShare, 0)}</span> of the matching hometown athletes.`,
      });
    } else {
      sections.push({
        h: anyFilter ? `Snapshot${scopeSuffix}` : 'Snapshot',
        p: `${fmtInt(total)} athletes across ${distinctSports} distinct sports match this filter.`,
      });
    }
    sections.push({
      h: 'Program Mix',
      p: `Winter sports account for <span class="accent">${fmtPct(winterShare, 0)}</span> of the matching totals. Pick a state on the map to see how its mix compares.`,
    });
    return {
      sections,
      followups: [
        { label: 'Highest Athlete Counts', q: 'top-states-athletes' },
        { label: 'Broadest Sport Diversity', q: 'top-states-diversity' },
        { label: 'Most Paralympic Athletes', q: 'top-states-paralympic' },
      ],
    };
  }

  // Single state selected
  const code = _state.selectedState;
  const name = STATE_NAMES[code] || code;
  const stTot = getScopedStateTotals(code, filters);
  if (stTot.total === 0 && anyFilter) {
    return {
      sections: [{ h: `${name}${scopeSuffix}`, p: `No athletes from ${name} match the current filter combination.` }],
      followups: [
        { label: `Compare ${name} to Another State`, q: 'compare', stateCode: code },
      ],
    };
  }

  const share = nat.total ? stTot.total / nat.total : 0;
  // Top sports/hubs honor the same filter scope as everything else.
  // Top sports intentionally omits sport filter — narrowing to one sport
  // would just return that sport. Hubs DO honor sport filter so the list
  // matches what's visible in the rest of the brief.
  const topSports = getTopSportsForState(code, { limit: 3, program: filters.program, season: filters.season });
  const topHubs   = getTopHometownsScoped({ state: code, program: filters.program, season: filters.season, sport: filters.sport }, 3);
  const seasonLeader = (stTot.summer || 0) >= (stTot.winter || 0) ? 'summer' : 'winter';
  const seasonShare = stTot.total
    ? (seasonLeader === 'summer' ? stTot.summer : stTot.winter) / stTot.total
    : 0;
  return {
    sections: [
      {
        h: anyFilter ? `Snapshot${scopeSuffix}` : 'Snapshot',
        p: `<span class="accent">${name}</span> contributes <span class="accent">${fmtInt(stTot.total)}</span> athletes — <span class="accent">${fmtPct(share, 1)}</span> of the${anyFilter ? ' matching' : ' national'} total — spread across <span class="accent">${stTot.sportCount}</span> distinct sports.`,
      },
      topSports.length ? {
        h: 'Top Sports',
        p: topSports.map((s) => `<span class="accent">${s.sport}</span> (${fmtInt(s.athletes)})`).join(' · '),
      } : null,
      topHubs.length ? {
        h: 'Hometown Hubs',
        p: topHubs.map((h) => `<span class="accent">${h.hometown_city}</span> (${fmtInt(h.total_athletes)})`).join(' · '),
      } : null,
      {
        h: 'Program & Season',
        p: `Olympic ${fmtInt(stTot.olympic)} · Paralympic ${fmtInt(stTot.paralympic)} (Paralympic share <span class="accent">${fmtPct(stTot.paralympicShare, 1)}</span>). Lean ${seasonLeader} — ${fmtPct(seasonShare, 0)} of the${anyFilter ? ' matching' : ' state\'s'} athletes.`,
      },
    ].filter(Boolean),
    followups: [
      { label: `Compare ${name} to Another State`, q: 'compare', stateCode: code },
      { label: 'Most Balanced Parity States', q: 'most-balanced-parity' },
      { label: 'Top Hometown Hubs Nationally', q: 'top-hometown-hubs' },
    ],
  };
}

// Token bumped on every renderInsight() so an in-flight Gemini response
// from a stale filter combo can't overwrite the current view.
let _atlasInsightToken = 0;

function setAtlasInsightBadge(kind, label) {
  const head = document.querySelector('#geminiInsight .gemini__head');
  if (!head) return;
  let badge = head.querySelector('.gemini__source');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'gemini__source';
    head.appendChild(badge);
  }
  badge.dataset.kind = kind;
  badge.textContent = label;
}

function clearAtlasInsightBadge() {
  const badge = document.querySelector('#geminiInsight .gemini__head .gemini__source');
  if (badge) badge.remove();
}

// Convert a deterministic `brief` (sections of {h, p}) into the unified
// {title, bullets, caveat} envelope so the local fallback renders with
// the exact same template, typography, and word-by-word reveal as a
// Gemini response. The first section's heading becomes the card title;
// every section paragraph becomes a plain bullet — no inline category
// label — so the local fallback is visually indistinguishable from a
// real Gemini answer (the user has explicitly asked for this parity).
function briefToEnvelope(brief, defaultTitle = 'Regional Insight') {
  const sections = Array.isArray(brief?.sections) ? brief.sections : [];
  if (!sections.length) return { title: defaultTitle, bullets: [], caveat: '' };
  const [first, ...rest] = sections;
  const bullets = [];
  if (first?.p) bullets.push(first.p);
  rest.forEach((s) => {
    if (!s?.p) return;
    bullets.push(s.p);
  });
  return {
    title: first?.h || defaultTitle,
    bullets,
    caveat: '',
  };
}

function renderInsight() {
  const body   = document.getElementById('geminiBody');
  const follow = document.getElementById('geminiFollow');
  if (!body) return;
  const filters = activeFilters();
  const cacheKey = makeContextCacheKey({
    view: 'atlas',
    state: _state.selectedState || null,
    program: filters.program || null,
    season: filters.season || null,
    sport: filters.sport || null,
    metric: _state.metric || null,
  });
  const context = getOrBuildContext('atlas', cacheKey, () =>
    getAtlasContext({ filters, selectedState: _state.selectedState }),
  );
  // Build deterministic content lazily so we always have a fallback ready,
  // but never paint it unless Gemini actually fails / times out.
  const buildLocal = () => {
    const brief = buildBrief();
    const _envelope = makeRegionalBrief({
      title: brief.sections[0]?.h || 'Regional Insight',
      bullets: brief.sections.map((s) => htmlToPlainText(s.p)),
      caveat: '',
      followUps: brief.followups.map((f) => f.label),
    });
    void _envelope;
    return brief;
  };

  // 1. Skeleton first — no flash of "Local insight" content. The user sees
  //    Gemini reading the page and then either Gemini's answer or, on
  //    failure, the deterministic write-up. Mirrors the Ask the Analyst
  //    Gemini-first flow.
  renderInsightSkeleton(body);
  setAtlasInsightBadge('loading', 'Gemini reading…');
  // Followups are deterministic and don't depend on Gemini, so render them
  // immediately so the user can interact while Gemini is in flight.
  if (follow) {
    const earlyBrief = buildLocal();
    follow.innerHTML = earlyBrief.followups.map((f) =>
      `<button type="button" class="followup-chip" data-followup="${f.q}" ${f.stateCode ? `data-state="${f.stateCode}"` : ''}>${f.label}</button>`
    ).join('');
  }

  // 2. Try Gemini. On success render its answer; on any failure / timeout
  //    fall back to the deterministic write-up. Either way attach a fresh
  //    copy button at the end so the clipboard always reflects what's
  //    actually on screen.
  const myToken = ++_atlasInsightToken;
  generateInsight('atlas_insight', context, { cacheKey }).then((resp) => {
    if (myToken !== _atlasInsightToken) return;
    if (resp?.source === 'gemini' && resp.result) {
      renderInsightBody(body, {
        title: resp.result.title || 'Regional Insight',
        bullets: resp.result.bullets,
        caveat: resp.result.caveat,
      });
      // No purple "Gemini-generated" badge — the user has asked for the
      // source pills to be removed across the app.
      clearAtlasInsightBadge();
    } else {
      renderInsightBody(body, briefToEnvelope(buildLocal(), 'Regional Insight'));
      // No badge on the local fallback — the absence of a Gemini badge is
      // itself the "this wasn't AI-generated" signal. Avoids visual clutter
      // and the user explicitly does not want a "Local insight" pill.
      clearAtlasInsightBadge();
    }
    attachCopyButton(body, () => htmlToPlainText(body.innerHTML));
  });
}

// ---------- Hometown concentration chip ----------

function renderConcentrationChip() {
  const el = document.getElementById('hometownConcChip');
  if (!el) return;
  const filters = activeFilters();
  const code = _state.selectedState;

  if (code) {
    // State-scoped concentration: top 3 hubs in the current view ÷ scoped state total.
    const hubs = getTopHometownsScoped(
      { state: code, program: filters.program, season: filters.season, sport: filters.sport },
      3,
    );
    const stTot = getScopedStateTotals(code, filters).total;
    if (!hubs.length || !stTot) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    const sumTop3 = hubs.reduce((acc, h) => acc + ((h.total_athletes ?? h.athletes) || 0), 0);
    const pct = Math.round((sumTop3 / stTot) * 100);
    el.hidden = false;
    el.textContent = `Top 3 hubs account for ${pct}% of visible athletes in this view.`;
    return;
  }

  // National view: top 10 hubs vs scoped national total.
  const hubs = getTopHometownsScoped(
    { state: null, program: filters.program, season: filters.season, sport: filters.sport },
    10,
  );
  const natTot = getScopedNationalTotals(filters).total;
  if (!hubs.length || !natTot) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const sumTop10 = hubs.reduce((acc, h) => acc + ((h.total_athletes ?? h.athletes) || 0), 0);
  const pct = Math.round((sumTop10 / natTot) * 100);
  el.hidden = false;
  el.textContent = `Hometown concentration: top 10 hubs represent ${pct}% of the current filtered total.`;
}

// ---------- Guided exploration lenses ----------

function renderLensChips() {
  const host = document.getElementById('atlasLensRow');
  if (!host) return;
  host.innerHTML = ATLAS_LENSES.map((lens) => {
    const pressed = _activeLens === lens.id;
    return `<button type="button" class="atlas-lens__chip${pressed ? ' is-active' : ''}" data-lens="${lens.id}" aria-pressed="${pressed ? 'true' : 'false'}">${lens.label}</button>`;
  }).join('');
}

function applyLens(lensId) {
  const lens = ATLAS_LENSES.find((l) => l.id === lensId);
  if (!lens) return;
  _applyingLens = true;
  _state.metric  = lens.metric;
  _state.program = lens.program;
  _state.season  = lens.season;
  _state.sport   = lens.sport;
  const fb = document.getElementById('filterbar');
  if (fb) {
    const ms = fb.querySelector('select[data-filter="metric"]');  if (ms) ms.value = _state.metric;
    const ps = fb.querySelector('select[data-filter="program"]'); if (ps) ps.value = _state.program;
    const ss = fb.querySelector('select[data-filter="season"]');  if (ss) ss.value = _state.season;
    const sp = fb.querySelector('select[data-filter="sport"]');   if (sp) sp.value = _state.sport;
  }
  syncMetricOptions();
  _activeLens = lens.id;
  rerender();
  updateUrlState({
    program: _state.program === 'both' ? null : _state.program,
    season:  _state.season  === 'all'  ? null : _state.season,
    sport:   _state.sport   === 'any'  ? null : _state.sport,
    metric:  _state.metric  === 'total' ? null : _state.metric,
    lens:    _activeLens || null,
  });
  _applyingLens = false;
}

function wireLensChips() {
  const host = document.getElementById('atlasLensRow');
  if (!host) return;
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('.atlas-lens__chip[data-lens]');
    if (!btn) return;
    applyLens(btn.dataset.lens);
  });
}

// ---------- Current View summary card ----------

const METRIC_SENTENCE = {
  total:     'Total athletes',
  share:     'Share of national',
  diversity: 'Sport diversity',
  parity:    'Parity balance',
};

function renderCurrentView() {
  const filtersEl = document.getElementById('atlasCurrentFilters');
  const topStateEl = document.getElementById('atlasCurrentTopState');
  const topHubEl   = document.getElementById('atlasCurrentTopHub');
  const statesEl   = document.getElementById('atlasCurrentStates');
  if (!filtersEl || !topStateEl || !topHubEl || !statesEl) return;

  const filters = activeFilters();
  const bits = [];
  if (_state.metric && _state.metric !== 'total') bits.push(METRIC_SENTENCE[_state.metric] || _state.metric);
  if (filters.program) bits.push(`${filters.program} only`);
  if (filters.season)  bits.push(`${filters.season} season`);
  if (filters.sport)   bits.push(filters.sport);
  if (_state.selectedState) bits.push(`State: ${STATE_NAMES[_state.selectedState] || _state.selectedState}`);
  filtersEl.textContent = bits.length ? bits.join(' · ') : 'All filters at default';

  // Top state in current view (ignores selectedState scope so the ranking is
  // across all states under the active filter combo — selectedState is shown
  // as a filter bit above when present). Ranks by the active metric so e.g.
  // "Paralympic Share" doesn't silently fall back to ranking by total athletes.
  const aggMap = getStateAggregateMap(filters);
  const nationalTotal = getScopedNationalTotals(filters).total;
  const metricKey = _state.metric || 'total';
  const valueOf = (a) => {
    if (!a) return 0;
    if (metricKey === 'parity')    return a.paralympicShare || 0;
    if (metricKey === 'share')     return nationalTotal ? (a.total || 0) / nationalTotal : 0;
    if (metricKey === 'diversity') return a.sportCount || 0;
    return a.total || 0;
  };
  const formatTopVal = (v) => {
    if (metricKey === 'parity' || metricKey === 'share') return `${(v * 100).toFixed(1)}%`;
    if (metricKey === 'diversity') return `${v} sports`;
    return fmtInt(v);
  };
  let topState = null;
  let topVal = -Infinity;
  let statesRepresented = 0;
  for (const [, a] of aggMap) {
    if ((a.total || 0) > 0) statesRepresented += 1;
    const v = valueOf(a);
    if (v > topVal && (a.total || 0) > 0) { topVal = v; topState = a; }
  }
  if (topState && topVal > 0) {
    const nm = STATE_NAMES[topState.state] || topState.state;
    topStateEl.textContent = `${nm} (${formatTopVal(topVal)})`;
  } else {
    topStateEl.textContent = '—';
  }

  const hubs = getTopHometownsScoped(
    { state: _state.selectedState || null, program: filters.program, season: filters.season, sport: filters.sport },
    1,
  );
  if (hubs.length) {
    const h = hubs[0];
    const count = (h.total_athletes ?? h.athletes) || 0;
    topHubEl.textContent = `${h.hometown_city}, ${h.hometown_state} (${fmtInt(count)})`;
  } else {
    topHubEl.textContent = '—';
  }

  statesEl.textContent = fmtInt(statesRepresented);
}

// ---------- Similar states ----------

// Similar State Profiles card — when a state is selected, chips show
// the 3 closest peers (by athlete count, sport diversity, winter share,
// Paralympic share, parity balance). When no state is selected we mirror
// the climate-context card's empty-state messaging so the card stays
// visible (rather than silently disappearing) and tells the user how to
// reveal real peer matches.
function renderSimilarStates() {
  const card = document.getElementById('similarStatesCard');
  const list = document.getElementById('similarStatesList');
  if (!card || !list) return;
  const code = _state.selectedState;
  if (!code) {
    card.hidden = false;
    list.innerHTML = `
      <div class="atlas-similar__placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="9" cy="9" r="6"/><circle cx="17" cy="17" r="4"/><path d="m13.5 13.5 1 1"/>
        </svg>
        <div>
          <div class="atlas-similar__placeholder-title">Pick a state to see its peers</div>
          <div class="atlas-similar__placeholder-sub">Click any state on the map (or open one from the bar lists) to see the three closest profile matches across athlete count, sport diversity, winter share, Paralympic share, and parity balance.</div>
        </div>
      </div>
    `;
    return;
  }
  card.hidden = false;
  const peers = findSimilarStates(code, { n: 3 });
  if (!peers.length) {
    list.innerHTML = '<div class="atlas-similar__empty">No comparable states found.</div>';
    return;
  }
  list.innerHTML = peers.map((p) => `
    <button type="button" class="atlas-similar__chip" data-state="${p.state}">
      <span class="atlas-similar__name">${p.name}</span>
      <span class="atlas-similar__dot" aria-hidden="true">·</span>
      <span class="atlas-similar__why">${p.closestLabel}</span>
    </button>
  `).join('');
}

// ---------- Map title + legend ----------

function renderMapHeader(label) {
  const t = document.getElementById('mapTitle');
  if (t) {
    const scope = sportScopeLabel();
    t.textContent = scope ? `${label} (${scope})` : label;
  }
  renderLegendRamp('legendRamp');
}

// ---------- Full re-render ----------

function isAtlasAtDefaults() {
  return _state.metric === 'total'
    && _state.program === 'both'
    && _state.season  === 'all'
    && _state.sport   === 'any'
    && !_state.selectedState
    && !_activeLens;
}

function syncResetButtonState() {
  const btn = document.getElementById('filterReset');
  if (!btn) return;
  btn.classList.toggle('is-default', isAtlasAtDefaults());
}

/**
 * Build the canonical "Top 10 Hometown Hubs" list under the current Atlas
 * scope. This is the single source of truth — both renderHubList() and the
 * map bubble overlay read from this so they stay in lockstep across every
 * filter change and state click.
 *
 * Returns: [{ hometown_key, hometown_city, hometown_state, total_athletes,
 *             olympic_athletes, paralympic_athletes }]
 */
function buildTopHubItems() {
  const filters = activeFilters();

  if (_state.sport !== 'any') {
    // Sport filter active → use scoped hub aggregator so the Olympic /
    // Paralympic split per hub comes from real participation rows. Previously
    // this branch synthesised the split (every athlete labeled Olympic unless
    // the program filter was para), which was wrong for "Both" + sport
    // combinations like Para Track and Field.
    const limit = _state.selectedState ? 500 : 10;
    let rows = getTopHometownsScoped(
      { sport: _state.sport, state: _state.selectedState || null,
        program: filters.program, season: filters.season },
      limit,
    );
    if (_state.selectedState) rows = rows.slice(0, 10);
    return rows;
  }

  return getTopHometownsScoped(
    { state: _state.selectedState || null, program: filters.program, season: filters.season },
    10,
  );
}

/**
 * Attach SVG x/y from hometown_geo.json to each item in the top-hubs list so
 * the map bubble layer can render them. Items with no geo entry are dropped
 * silently — the map simply omits a bubble for those. Read-only join: the
 * source list is left untouched (renderHubList still uses the full list).
 */
function attachBubbleCoords(items) {
  if (!items || !items.length) return [];
  const geo = getStore().hometownGeo || [];
  const byKey = new Map(geo.map((g) => [g.hometown_key, g]));
  const out = [];
  for (const it of items) {
    const g = byKey.get(it.hometown_key);
    if (!g || g.x == null || g.y == null) continue;
    out.push({ ...it, x: g.x, y: g.y });
  }
  return out;
}

function rerender() {
  const { valueByState, label, format } = buildValueMap();
  const topHubs = buildTopHubItems();
  const bubbles = attachBubbleCoords(topHubs);
  renderMapHeader(label);
  renderMap('mapStage', {
    valueByState,
    metricLabel: label,
    format,
    selected: _state.selectedState,
    onSelect: selectState,
    bubbles,
    bubbleLabel: 'Athletes',
  });
  renderStateOverview();
  renderSportList();
  renderHubList(topHubs);
  renderConcentrationChip();
  renderClimate();
  renderInsight();
  renderSimilarStates();
  renderCurrentView();
  renderLensChips();
  syncResetButtonState();
}

// ---------- Atlas filter reset (shared with hash-driven entry) ----------

function resetAtlasFilters() {
  _state.metric = 'total';
  _state.program = 'both';
  _state.season = 'all';
  _state.sport = 'any';
  _state.selectedState = null;
  _activeLens = null;
  const fb = document.getElementById('filterbar');
  if (fb) {
    const ms = fb.querySelector('select[data-filter="metric"]');  if (ms) ms.value = 'total';
    const ps = fb.querySelector('select[data-filter="program"]'); if (ps) ps.value = 'both';
    const ss = fb.querySelector('select[data-filter="season"]');  if (ss) ss.value = 'all';
    const sp = fb.querySelector('select[data-filter="sport"]');   if (sp) sp.value = 'any';
  }
  syncMetricOptions();
}

// ---------- Selection ----------

function selectState(code) {
  _state.selectedState = (code === _state.selectedState) ? null : code;
  rerender();
  updateUrlState({ state: _state.selectedState || null });
}

// ---------- Wiring (run once) ----------

function wireFilters() {
  const fb = document.getElementById('filterbar');
  if (!fb) return;
  fb.addEventListener('change', (e) => {
    const sel = e.target.closest('select.filter-select');
    if (!sel) return;
    const which = sel.dataset.filter;
    if (!which) return;
    _state[which] = sel.value;
    if (which === 'sport' || which === 'program') syncMetricOptions();
    if (!_applyingLens) _activeLens = null;
    rerender();
    updateUrlState({
      program: _state.program === 'both' ? null : _state.program,
      season:  _state.season  === 'all'  ? null : _state.season,
      sport:   _state.sport   === 'any'  ? null : _state.sport,
      metric:  _state.metric  === 'total' ? null : _state.metric,
      lens:    _activeLens || null,
    });
  });
  // Atlas Reset = restore every filter (metric/program/season/sport) to its
  // default, drop any selected state + active lens, sync the dropdowns,
  // re-render, and strip filter params from the URL. Hidden cards
  // (climate, similar states, etc.) are toggled off via `el.hidden=true`
  // inside the rerender; the global `[hidden]{display:none!important}`
  // rule in base.css guarantees those toggles stick.
  const reset = document.getElementById('filterReset');
  if (reset) {
    reset.addEventListener('click', () => {
      _state.metric = 'total';
      _state.program = 'both';
      _state.season = 'all';
      _state.sport = 'any';
      _state.selectedState = null;
      _activeLens = null;
      const ms = fb.querySelector('select[data-filter="metric"]');  if (ms) ms.value = 'total';
      const ps = fb.querySelector('select[data-filter="program"]'); if (ps) ps.value = 'both';
      const ss = fb.querySelector('select[data-filter="season"]');  if (ss) ss.value = 'all';
      const sp = fb.querySelector('select[data-filter="sport"]');   if (sp) sp.value = 'any';
      syncMetricOptions();
      rerender();
      updateUrlState({ program: null, season: null, sport: null, state: null, metric: null, lens: null });
    });
  }
  const resetState = document.getElementById('resetStateBtn');
  if (resetState) resetState.addEventListener('click', () => selectState(null));

  wireFollowupChips();
  wireSimilarChips();
  wireLensChips();
}

function wireSimilarChips() {
  const list = document.getElementById('similarStatesList');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.atlas-similar__chip[data-state]');
    if (!btn) return;
    const code = btn.dataset.state;
    if (!code) return;
    _state.selectedState = code;
    rerender();
    updateUrlState({ state: code });
  });
}

function wireFollowupChips() {
  const follow = document.getElementById('geminiFollow');
  if (!follow) return;
  follow.addEventListener('click', (e) => {
    const chip = e.target.closest('.followup-chip[data-followup]');
    if (!chip) return;
    const id = chip.dataset.followup;
    const stateCode = chip.dataset.state || null;

    if (id === 'compare') {
      // Deep-link to Compare with stateA preselected (compare page reads via consumeViewParams)
      setView('compare', stateCode ? { stateA: stateCode } : null);
      return;
    }
    if (FOLLOWUP_QUESTION_IDS.has(id)) {
      setView('ask', { questionId: id });
      return;
    }
    // Unknown follow-up id → fall back to plain Ask navigation
    setView('ask');
  });
}

registerView('atlas', () => {
  if (!_initialised) {
    populateProgramSelect();
    populateSeasonSelect();
    populateSportSelect();
    syncMetricOptions();
    wireFilters();
    _initialised = true;
  }
  // Cross-page deep links: parity rows / methodology snapshot / compare reset can
  // call setView('atlas', { state: 'CA' }) and we'll preselect that state.
  // Hash-driven entries (paste, back button, story-path click) carry __fromHash
  // and are treated as URL-is-source-of-truth: filters reset before params apply.
  const params = consumeViewParams();
  if (params?.__fromHash) {
    resetAtlasFilters();
  }
  if (params?.lens) {
    // Apply lens by id; this sets metric/program/season/sport in one shot and
    // syncs the filterbar selects.
    applyLens(params.lens);
  } else {
    // Back-compat for bookmarked URLs that used the removed metric values.
    // Coerce them to `total` and apply the equivalent program/season filter
    // when the URL didn't already specify one — this preserves the visual
    // intent of the old link (e.g. ?metric=para → program=para + total).
    const incomingMetric = params?.metric;
    if (incomingMetric === 'oly' || incomingMetric === 'para') {
      _state.metric = 'total';
      if (!params.program) _state.program = incomingMetric;
    } else if (incomingMetric === 'summer' || incomingMetric === 'winter') {
      _state.metric = 'total';
      if (!params.season) _state.season = incomingMetric;
    } else if (incomingMetric && METRIC_LABEL[incomingMetric]) {
      _state.metric = incomingMetric;
    }
    if (params?.program && params.program !== _state.program) {
      _state.program = params.program;
    }
    if (params?.season && params.season !== _state.season) {
      _state.season = params.season;
    }
    if (params?.sport && params.sport !== _state.sport) {
      _state.sport = params.sport;
    }
    syncMetricOptions();
  }
  if (params?.state && params.state !== _state.selectedState) {
    _state.selectedState = params.state;
  }
  // Reflect any restored filter values back into the filterbar UI.
  if (params && (params.program || params.season || params.sport || params.metric || params.lens || params.__fromHash)) {
    const fb = document.getElementById('filterbar');
    if (fb) {
      const ms = fb.querySelector('select[data-filter="metric"]');  if (ms) ms.value = _state.metric;
      const ps = fb.querySelector('select[data-filter="program"]'); if (ps) ps.value = _state.program;
      const ss = fb.querySelector('select[data-filter="season"]');  if (ss) ss.value = _state.season;
      const sp = fb.querySelector('select[data-filter="sport"]');   if (sp) sp.value = _state.sport;
    }
  }
  rerender();
});
