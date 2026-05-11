/**
 * pages/parity.js — Parity Lens
 *
 * View-mode selector (Paralympic count / Parity ratio / Both) injected into the
 * parity card's toolbar. Season + min-athlete filters add a small control row.
 *
 * Renders:
 *   - #mapStageParity (choropleth of selected metric)
 *   - #legendRampParity
 *   - #parityShareList (top 10 by selected metric)
 *   - #parityBalanceList (most balanced w/ min-athlete floor)
 *   - #parityInsightBody / #parityInsightFollow
 */

import { registerView, setView, consumeViewParams, updateUrlState } from '../lib/router.js';
import { getStore, STATE_NAMES, PARITY_MIN_DENOMINATOR } from '../data/store.js';
import { getParityLensData, getParalympicSportFootprint, filterBothProgramHubs } from '../helpers/parity.js';
import { renderMap, renderLegendRamp } from '../ui/map.js';
import { fmtInt, fmtPct } from '../ui/kpi.js';
import { attachCopyButton, htmlToPlainText } from '../ui/copyButton.js';
import { getParityContext } from '../helpers/context.js';
import { makeContextCacheKey } from '../helpers/cacheKey.js';
import { makeParityBrief } from '../helpers/responseSchemas.js';
import { getOrBuildContext } from '../helpers/contextCache.js';
import { generateInsight } from '../lib/gemini.js';
import { renderInsightSkeleton, renderInsightBody } from '../ui/insightSkeleton.js';

const DEFAULT_STATE = Object.freeze({
  view: 'paralympic',           // 'paralympic' | 'parity'  (legacy 'dual' was removed: it was visually
                                // ~95% identical to Paralympic Count because most states have more
                                // Olympic than Paralympic athletes, so min(Oly, Para) ≈ Para count —
                                // it just confused users without adding a distinct insight.)
  season: 'all',                // 'all' | 'summer' | 'winter'
  minAthletes: PARITY_MIN_DENOMINATOR,
  footprintExpanded: false,
});

const _state = { ...DEFAULT_STATE };
let _initialised = false;

const FOOTPRINT_COLLAPSED_LIMIT = 10;

const TITLES = {
  paralympic: 'Paralympic Athletes by State',
  parity: 'Paralympic Share by State',
};

const SEASON_LABEL = { summer: 'Summer', winter: 'Winter' };

const VALID_SEASON = new Set(['all', 'summer', 'winter']);

function seasonFilter() { return _state.season === 'summer' ? 'Summer' : _state.season === 'winter' ? 'Winter' : null; }

function injectControls() {
  // No-op: filters now live in the page's standalone .filterbar (#filterbarParity)
  // matching Atlas + Sport. Kept as a stub so call sites stay stable.
  return;
}

// Per-state totals, respecting the active season filter (used to gate the
// choropleth and ranked lists by `_state.minAthletes`).
function totalsByState(seas) {
  const store = getStore();
  if (!seas) {
    const out = {};
    for (const r of store.stateSummary) out[r.state] = r.total_athletes || 0;
    return out;
  }
  const tally = new Map();
  for (const p of store.participation) {
    if (p.season !== seas) continue;
    if (!p.hometown_state) continue;
    const set = tally.get(p.hometown_state) || new Set();
    set.add(p.athlete_id);
    tally.set(p.hometown_state, set);
  }
  const out = {};
  for (const [st, set] of tally) out[st] = set.size;
  return out;
}

// `_state.minAthletes` floors EVERY view consistently. States below the floor
// are dropped from `valueByState` so the legend ramp scales to qualifying
// states only and ranked lists/atlas-drilldown stay consistent with the map.
function buildValueMap() {
  const store = getStore();
  const seas = seasonFilter();
  const min = _state.minAthletes;
  const totals = totalsByState(seas);
  const passes = (st) => (totals[st] || 0) >= min;

  if (_state.view === 'paralympic') {
    const map = {};
    // Always derive from participation (distinct athlete_ids) so the map and
    // the ranked list/insight read from one source. state_summary's
    // paralympic_athletes is a pre-computed snapshot that drifts ~91 athletes
    // from the participation-derived count due to dual-classified athletes.
    const tally = new Map();
    for (const p of store.participation) {
      if (p.sport_type !== 'Paralympic') continue;
      if (seas && p.season !== seas) continue;
      if (!p.hometown_state) continue;
      const set = tally.get(p.hometown_state) || new Set();
      set.add(p.athlete_id);
      tally.set(p.hometown_state, set);
    }
    for (const [st, set] of tally) {
      if (!passes(st)) continue;
      map[st] = set.size;
    }
    return {
      valueByState: map,
      label: seas ? `${seas} Paralympic athletes` : 'Paralympic athletes',
      format: (v) => v == null ? '0' : Number(v).toLocaleString(),
    };
  }

  // Only two view modes remain: 'paralympic' (raw Paralympic count) and
  // 'parity' (Paralympic share of total). The legacy 'dual' mode (min of
  // Olympic and Paralympic per state) was removed — it was visually
  // near-identical to Paralympic Count for the vast majority of states.
  // 'parity' is the share branch.
  if (_state.view === 'parity') {
    // "Paralympic share of total" = paralympic / total per state, where total
    // is the DISTINCT-athlete count (matches getStateAggregateMap and the
    // ranked list). Always derive from participation so map and list agree;
    // never use o+pa as the denominator (that double-counts dual-classified
    // athletes). state_summary.parity_ratio is a balance score (min/max), NOT
    // the share-of-total — do not use it here.
    const map = {};
    const tot = new Map(), para = new Map();
    for (const p of store.participation) {
      if (seas && p.season !== seas) continue;
      if (!p.hometown_state) continue;
      const totSet = tot.get(p.hometown_state) || new Set();
      totSet.add(p.athlete_id);
      tot.set(p.hometown_state, totSet);
      if (p.sport_type === 'Paralympic') {
        const ps = para.get(p.hometown_state) || new Set();
        ps.add(p.athlete_id);
        para.set(p.hometown_state, ps);
      }
    }
    for (const [st, totSet] of tot) {
      if (!passes(st)) continue;
      const t = totSet.size;
      const pa = para.get(st)?.size || 0;
      map[st] = t ? pa / t : 0;
    }
    return {
      valueByState: map,
      label: seas ? `${seas} Paralympic share of total` : 'Paralympic share of total',
      format: (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`,
    };
  }

  // Defensive fallback: any unrecognized view mode falls back to the
  // Paralympic Count map so the page never blanks out (e.g. if a stale
  // URL hash still references the removed 'dual' mode). The two real
  // branches ('paralympic' / 'parity') both early-return above.
  return {
    valueByState: {},
    label: '—',
    format: (v) => v == null ? '—' : String(v),
  };
}

function renderShareList(lens) {
  const host = document.getElementById('parityShareList');
  if (!host) return;
  // Apply the min-athletes floor here too so the list stays consistent with
  // the choropleth and you don't see "Vermont leads" with a 5-athlete sample.
  const rows = lens.paralympicRanking
    .filter((r) => (r.total || 0) >= _state.minAthletes)
    .slice(0, 10);
  if (!rows.length) { host.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No states meet the minimum athlete floor.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.paralympic_athletes || 0));
  host.innerHTML = rows.map((r) => {
    const pct = max ? ((r.paralympic_athletes || 0) / max) * 100 : 0;
    return `
      <div class="bar-row bar--para is-clickable" data-state="${r.state}" title="Click to view ${r.name} in Atlas">
        <div class="label">${r.name}</div>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="v">${fmtInt(r.paralympic_athletes)}</div>
      </div>
    `;
  }).join('');
}

function renderBalanceList(lens) {
  const host = document.getElementById('parityBalanceList');
  const note = document.getElementById('parityBalanceMinNote');
  if (note) {
    const m = _state.minAthletes;
    note.textContent = m > 0 ? `(≥${m} athletes)` : '(no minimum)';
  }
  if (!host) return;
  const rows = lens.balancedRanking.slice(0, 10);
  if (!rows.length) { host.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No states meet the minimum athlete floor.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.paralympic_share));
  host.innerHTML = rows.map((r) => {
    const pct = max ? (r.paralympic_share / max) * 100 : 0;
    return `
      <div class="bar-row bar--para is-clickable" data-state="${r.state}" title="Click to view ${r.name} in Atlas">
        <div class="label">${r.name}</div>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="v">${(r.paralympic_share * 100).toFixed(1)}%</div>
      </div>
    `;
  }).join('');
}

// Token bumped on each renderInsight call so a stale Gemini response
// from a prior view/season/min-athletes combo can't overwrite the current view.
let _parityInsightToken = 0;

function setParityInsightBadge(kind, label) {
  const body = document.getElementById('parityInsightBody');
  const card = body?.closest('.gemini');
  const head = card?.querySelector('.gemini__head');
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

function clearParityInsightBadge() {
  const body = document.getElementById('parityInsightBody');
  const card = body?.closest('.gemini');
  const badge = card?.querySelector('.gemini__head .gemini__source');
  if (badge) badge.remove();
}

function renderGeminiParityInsight(result, body) {
  renderInsightBody(body, {
    title: result?.title || 'Parity Insight',
    bullets: result?.bullets,
    caveat: result?.caveat,
  });
}

function renderInsight(lens) {
  const body = document.getElementById('parityInsightBody');
  const follow = document.getElementById('parityInsightFollow');
  if (!body) return;
  const filters = { viewMode: _state.view, season: _state.season === 'all' ? null : _state.season, minAthletes: _state.minAthletes };
  const cacheKey = makeContextCacheKey({ view: 'parity', ...filters });
  const context = getOrBuildContext('parity', cacheKey, () =>
    getParityContext({ filters }),
  );

  // Build the deterministic write-up lazily; only paint it if Gemini fails.
  const buildLocal = () => {
    const topPara = lens.paralympicRanking.find((r) => (r.total || 0) >= _state.minAthletes);
    const topBal  = lens.balancedRanking[0];
    const dualHubsCount = lens.dualRepHubs.length;
    const paraSports = lens.paralympicSports.length;
    const sections = [
      {
        h: 'Paralympic Representation',
        p: `<span class="accent">${topPara?.name || '—'}</span> leads in Paralympic athletes (<span class="accent">${fmtInt(topPara?.paralympic_athletes || 0)}</span>). The data includes <span class="accent">${paraSports}</span> sports with at least one Paralympic athlete.`,
      },
      {
        h: 'Highest Paralympic Share',
        p: `Among states with ≥<span class="accent">${lens.minAthletes}</span> total athletes, <span class="accent">${topBal?.name || '—'}</span> has the highest Paralympic share at <span class="accent">${topBal ? fmtPct(topBal.paralympic_share, 1) : '—'}</span>. Tiny denominators are excluded so a single Paralympic athlete can't dominate.`,
      },
      {
        h: 'Dual-Program Presence',
        p: `<span class="accent">${lens.dualRepStates.length}</span> states and <span class="accent">${dualHubsCount}</span> hometown hubs have been home to both Olympic and Paralympic athletes.`,
      },
    ];
    const _envelope = makeParityBrief({
      title: 'Parity Lens',
      bullets: sections.map((s) => htmlToPlainText(s.p)),
      caveat: '',
      followUps: ['Paralympic Count', 'Paralympic Share', 'Both Programs'],
    });
    void _envelope;
    return sections;
  };

  // 1. Skeleton + Loading badge first.
  renderInsightSkeleton(body);
  setParityInsightBadge('loading', 'Gemini reading…');
  if (follow) {
    follow.innerHTML = `
      <button type="button" class="followup-chip" data-view="paralympic">Paralympic Count</button>
      <button type="button" class="followup-chip" data-view="parity">Paralympic Share</button>
    `;
  }

  // 2. Try Gemini. On success render its answer; on failure render the
  //    deterministic write-up. Either way attach a fresh copy button at
  //    the end so the clipboard always reflects what's on screen.
  const myToken = ++_parityInsightToken;
  generateInsight('parity_insight', context, { cacheKey }).then((resp) => {
    if (myToken !== _parityInsightToken) return;
    if (resp?.source === 'gemini' && resp.result) {
      renderGeminiParityInsight(resp.result, body);
      // No purple "Gemini-generated" badge — see atlas.js for rationale.
      clearParityInsightBadge();
    } else {
      const sections = buildLocal();
      renderInsightBody(body, {
        title: 'Parity Lens',
        // Plain bullets (no inline category prefix) so the local fallback
        // matches a Gemini response visually — same template, same
        // typography, same word-by-word reveal animation.
        bullets: sections.map((s) => s.p),
        caveat: '',
      });
      // No badge on the local fallback — see atlas.js for rationale.
      clearParityInsightBadge();
    }
    attachCopyButton(body, () => htmlToPlainText(body.innerHTML));
  });
}

function renderEqualFrame(lens) {
  const ef = lens.equalFrame || { olympic: { states: 0, hubs: 0, sports: 0 }, paralympic: { states: 0, hubs: 0, sports: 0 } };
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmtInt(v); };
  set('pfOlyStates', ef.olympic.states);
  set('pfOlyHubs', ef.olympic.hubs);
  set('pfOlySports', ef.olympic.sports);
  set('pfParaStates', ef.paralympic.states);
  set('pfParaHubs', ef.paralympic.hubs);
  set('pfParaSports', ef.paralympic.sports);
}

function renderOverlapKpis(lens) {
  const k = lens.overlapKpis || { overlapStates: 0, overlapHubs: 0, overlapSports: 0 };
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmtInt(v); };
  set('pkOverlapStates', k.overlapStates);
  set('pkOverlapHubs', k.overlapHubs);
  set('pkOverlapSports', k.overlapSports);
}

function renderHubsList(lens) {
  const host = document.getElementById('parityHubsList');
  if (!host) return;
  const baseRows = lens.representationHubs || [];
  const rows = filterBothProgramHubs(baseRows).slice(0, 10);
  if (!rows.length) {
    host.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No hometown hubs have both Olympic and Paralympic athletes under this filter.</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.total || 0));
  host.innerHTML = rows.map((r) => {
    const total = r.total || 0;
    const oly = r.olympic || 0;
    const para = r.paralympic || 0;
    // Per-row denominator falls back to oly+para when the total is smaller
    // (some hubs have dual-classified athletes so oly+para > total). This
    // keeps the stacked segments inside the bar visually for those rows.
    const denom = Math.max(max, oly + para);
    const olyPct = denom ? (oly / denom) * 100 : 0;
    const paraPct = denom ? (para / denom) * 100 : 0;
    const cityLabel = r.state ? `${r.city}, ${r.state}` : r.city;
    const tip = `${cityLabel}: ${fmtInt(oly)} Olympic + ${fmtInt(para)} Paralympic = ${fmtInt(total)} total`;
    return `
      <div class="bar-row bar-row--parity is-clickable" data-state="${r.state || ''}" title="${tip}">
        <div class="label">${cityLabel}</div>
        <div class="bar bar--stacked">
          <i class="seg seg--oly"  style="width:${olyPct.toFixed(1)}%"></i>
          <i class="seg seg--para" style="width:${paraPct.toFixed(1)}%; left:${olyPct.toFixed(1)}%"></i>
        </div>
        <div class="v v--split">
          <span class="v-oly">${fmtInt(oly)}</span>
          <span class="v-sep">·</span>
          <span class="v-para">${fmtInt(para)}</span>
          <span class="v-sep">=</span>
          <span class="v-total">${fmtInt(total)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderParaFootprint() {
  const host = document.getElementById('parityParaFootprintList');
  const toggle = document.getElementById('parityParaFootprintToggle');
  if (!host) return;
  const all = getParalympicSportFootprint({ season: seasonFilter() });
  if (!all.length) {
    host.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No Paralympic sports in the current view.</div>';
    if (toggle) toggle.style.display = 'none';
    return;
  }
  const expanded = _state.footprintExpanded || all.length <= FOOTPRINT_COLLAPSED_LIMIT;
  const rows = expanded ? all : all.slice(0, FOOTPRINT_COLLAPSED_LIMIT);
  host.innerHTML = `
    <div class="parity-para-footprint__head" role="row">
      <span class="pf-col pf-col--sport">Sport</span>
      <span class="pf-col pf-col--num">Athletes</span>
      <span class="pf-col pf-col--num">States</span>
      <span class="pf-col pf-col--num">Hubs</span>
    </div>
    ${rows.map((r) => `
      <div class="parity-para-footprint__row" role="listitem">
        <span class="pf-col pf-col--sport">${r.sport}</span>
        <span class="pf-col pf-col--num">${fmtInt(r.athletes)}</span>
        <span class="pf-col pf-col--num">${fmtInt(r.states)}</span>
        <span class="pf-col pf-col--num">${fmtInt(r.hubs)}</span>
      </div>
    `).join('')}
  `;
  if (toggle) {
    if (all.length <= FOOTPRINT_COLLAPSED_LIMIT) {
      toggle.style.display = 'none';
    } else {
      toggle.style.display = '';
      toggle.textContent = expanded ? 'Show top 10' : `Show all (${all.length})`;
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  }
}

function syncHubsToggleUI() {
  // Hubs toggle was removed; the list now always shows both-program hubs only.
  // Stub kept to avoid touching call sites that may still invoke it.
}

function rerender() {
  const { valueByState, label, format } = buildValueMap();
  const heading = document.querySelector('section.view[data-view="parity"] .parity-card .map-toolbar h3');
  if (heading) {
    const seas = seasonFilter();
    const base = TITLES[_state.view] || TITLES.paralympic;
    heading.textContent = seas ? `${base} — ${SEASON_LABEL[_state.season] || ''}` : base;
  }
  renderLegendRamp('legendRampParity', 'parity');
  renderMap('mapStageParity', {
    valueByState,
    metricLabel: label,
    format,
    onSelect: (code) => { if (code) setView('atlas', { state: code }); },
  });
  const lens = getParityLensData({ season: seasonFilter(), minAthletes: _state.minAthletes });
  renderShareList(lens);
  renderBalanceList(lens);
  renderEqualFrame(lens);
  renderOverlapKpis(lens);
  renderHubsList(lens);
  renderParaFootprint();
  syncHubsToggleUI();
  renderInsight(lens);
  syncResetButtonState();
}

function flashAndNavigate(row, code) {
  if (!code) return;
  if (!row) { setView('atlas', { state: code }); return; }
  const prevBg = row.style.background;
  const prevTransition = row.style.transition;
  row.style.transition = 'background 120ms ease';
  row.style.background = 'var(--accent-soft, rgba(110, 168, 254, 0.18))';
  setTimeout(() => {
    row.style.background = prevBg;
    row.style.transition = prevTransition;
    setView('atlas', { state: code });
  }, 140);
}

function wireBarListClicks(hostId) {
  const host = document.getElementById(hostId);
  if (!host || host.dataset.clickWired === 'true') return;
  host.addEventListener('click', (e) => {
    const row = e.target.closest('.bar-row[data-state]');
    if (!row || !host.contains(row)) return;
    flashAndNavigate(row, row.dataset.state);
  });
  host.dataset.clickWired = 'true';
}

function applyDefaultsToInputs() {
  const v  = document.getElementById('parityView');   if (v) v.value  = _state.view;
  const s  = document.getElementById('paritySeason'); if (s) s.value  = _state.season;
  const m  = document.getElementById('parityMin');    if (m) m.value  = String(_state.minAthletes);
}

function isParityAtDefaults() {
  return _state.view    === DEFAULT_STATE.view
      && _state.season  === DEFAULT_STATE.season
      && _state.minAthletes === DEFAULT_STATE.minAthletes;
}

function syncResetButtonState() {
  const btn = document.getElementById('parityReset');
  if (!btn) return;
  btn.classList.toggle('is-default', isParityAtDefaults());
}

// Parity Reset = wipe view-mode / season / min-athletes / footprint-expand
// flag back to DEFAULT_STATE, push defaults into the form inputs, strip
// the corresponding URL params, and re-render so the bar lists pick up
// the cleared filter.
function resetState() {
  _state.view = DEFAULT_STATE.view;
  _state.season = DEFAULT_STATE.season;
  _state.minAthletes = DEFAULT_STATE.minAthletes;
  _state.footprintExpanded = DEFAULT_STATE.footprintExpanded;
  applyDefaultsToInputs();
  updateUrlState({ season: null, viewMode: null, minAthletes: null, representation: null });
  rerender();
}

function syncUrl() {
  updateUrlState({
    season: _state.season === DEFAULT_STATE.season ? null : _state.season,
    viewMode: _state.view === DEFAULT_STATE.view ? null : _state.view,
    minAthletes: _state.minAthletes === DEFAULT_STATE.minAthletes ? null : String(_state.minAthletes),
  });
}

function wireControls() {
  document.getElementById('parityView')?.addEventListener('change', (e) => {
    _state.view = e.target.value;
    syncUrl();
    rerender();
  });
  document.getElementById('paritySeason')?.addEventListener('change', (e) => {
    _state.season = e.target.value;
    syncUrl();
    rerender();
  });
  document.getElementById('parityMin')?.addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    _state.minAthletes = Number.isFinite(n) && n >= 0 ? n : PARITY_MIN_DENOMINATOR;
    syncUrl();
    rerender();
  });
  document.getElementById('parityReset')?.addEventListener('click', resetState);
  document.getElementById('parityInsightFollow')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.followup-chip[data-view]');
    if (!chip) return;
    _state.view = chip.dataset.view;
    const sel = document.getElementById('parityView'); if (sel) sel.value = _state.view;
    syncUrl();
    rerender();
  });
  wireBarListClicks('parityShareList');
  wireBarListClicks('parityBalanceList');
  wireBarListClicks('parityHubsList');

  document.getElementById('parityParaFootprintToggle')?.addEventListener('click', () => {
    _state.footprintExpanded = !_state.footprintExpanded;
    renderParaFootprint();
  });
}

// Valid view modes for the Paralympic Lens dropdown. The legacy 'dual'
// (min(Olympic, Paralympic)) mode was removed — see DEFAULT_STATE comment.
// Any URL hash carrying the old 'dual' value falls through to the
// Paralympic Count default via VALID_VIEW_MODE.has(...) below.
const VALID_VIEW_MODE = new Set(['paralympic', 'parity']);

registerView('parity', () => {
  if (!_initialised) {
    injectControls();
    wireControls();
    _initialised = true;
  }
  const params = consumeViewParams();
  if (params && typeof params === 'object') {
    if (params.__fromHash) {
      _state.view = DEFAULT_STATE.view;
      _state.season = DEFAULT_STATE.season;
      _state.minAthletes = DEFAULT_STATE.minAthletes;
    }
    if (typeof params.season === 'string' && VALID_SEASON.has(params.season)) {
      _state.season = params.season;
    }
    if (typeof params.viewMode === 'string' && VALID_VIEW_MODE.has(params.viewMode)) {
      _state.view = params.viewMode;
    }
    if (params.minAthletes != null) {
      const n = parseInt(params.minAthletes, 10);
      if (Number.isFinite(n) && n >= 0) _state.minAthletes = n;
    }
    applyDefaultsToInputs();
  }
  rerender();
});
