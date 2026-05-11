/**
 * helpers/parity.js — Olympic/Paralympic parity views
 *
 * Two distinct metrics:
 *   • paralympic_share = paralympic / total — composition (what fraction of
 *     athletes are Paralympic). Range 0..~0.20.
 *   • balance_index    = min(oly, para) / max(oly, para) — symmetry score,
 *     0 (totally lopsided) → 1 (perfectly balanced).
 *
 * The "balanced" ranking surfaces highest-Paralympic-share states above an
 * athlete-count floor so a single Paralympic athlete in a tiny state can't
 * inflate the share. Default floor lives in store.js (PARITY_MIN_DENOMINATOR).
 */

import { getStore, STATE_NAMES, PARITY_MIN_DENOMINATOR } from '../data/store.js';

function bypass(value) {
  return value === null || value === undefined || value === '' || value === 'All' || value === 'all';
}

function filterStateRowsBySeason(season) {
  // ALWAYS derive from participation so paralympic_share matches the Atlas /
  // Compare / Ask views. The state_summary.parity_ratio JSON column stores a
  // min/max balance score (NOT paralympic_share) and is computed from
  // has_para_classification — both differ from the distinct-athlete
  // Paralympic count under participation, so we never read that column here.
  const seasoned = !bypass(season);
  const tally = new Map();
  for (const r of getStore().participation) {
    if (seasoned && r.season !== season) continue;
    const cur = tally.get(r.hometown_state) || {
      state: r.hometown_state,
      athletes: new Set(),
      olympic: new Set(),
      paralympic: new Set(),
      sports: new Set(),
    };
    cur.athletes.add(r.athlete_id);
    if (r.sport_type === 'Olympic')    cur.olympic.add(r.athlete_id);
    if (r.sport_type === 'Paralympic') cur.paralympic.add(r.athlete_id);
    if (r.sport) cur.sports.add(r.sport);
    tally.set(r.hometown_state, cur);
  }
  return Array.from(tally.values()).map((t) => {
    const total = t.athletes.size;
    const oly = t.olympic.size;
    const para = t.paralympic.size;
    const minProg = Math.min(oly, para);
    const maxProg = Math.max(oly, para);
    return {
      state: t.state,
      total_athletes: total,
      olympic_athletes: oly,
      paralympic_athletes: para,
      paralympic_share: total ? para / total : 0,
      balance_index: maxProg ? minProg / maxProg : 0,
      sport_count: t.sports.size,
    };
  });
}

function tallyHometownsBySeason(season) {
  // ALWAYS derive from participation; hometown_summary's parity_ratio uses
  // has_para_classification and won't match Atlas/Compare numbers either.
  const seasoned = !bypass(season);
  const tally = new Map();
  for (const r of getStore().participation) {
    if (seasoned && r.season !== season) continue;
    if (!r.hometown_key) continue;
    const cur = tally.get(r.hometown_key) || {
      hometown_city: r.hometown_city,
      hometown_state: r.hometown_state,
      hometown_key: r.hometown_key,
      athletes: new Set(), olympic: new Set(), paralympic: new Set(),
    };
    cur.athletes.add(r.athlete_id);
    if (r.sport_type === 'Olympic')    cur.olympic.add(r.athlete_id);
    if (r.sport_type === 'Paralympic') cur.paralympic.add(r.athlete_id);
    tally.set(r.hometown_key, cur);
  }
  return Array.from(tally.values()).map((t) => {
    const total = t.athletes.size;
    const oly = t.olympic.size;
    const para = t.paralympic.size;
    const minProg = Math.min(oly, para);
    const maxProg = Math.max(oly, para);
    return {
      hometown_city: t.hometown_city,
      hometown_state: t.hometown_state,
      hometown_key: t.hometown_key,
      total_athletes: total,
      olympic_athletes: oly,
      paralympic_athletes: para,
      paralympic_share: total ? para / total : 0,
      balance_index: maxProg ? minProg / maxProg : 0,
    };
  });
}

/**
 * @param {Object}  [opts]
 * @param {?string} [opts.season]         Season filter ('Summer'|'Winter'|null/'all').
 * @param {number}  [opts.minAthletes]    Denominator floor for balancedRanking.
 * @param {'all'|'oly_only'|'para_only'|'both'} [opts.representation]
 *        Filter for the new `representationHubs` field:
 *          - 'all'       → hubs with >=1 athlete (default)
 *          - 'oly_only'  → Olympic > 0 AND Paralympic == 0
 *          - 'para_only' → Paralympic > 0 AND Olympic == 0
 *          - 'both'      → both > 0 (same predicate as dualRepHubs)
 *        Does NOT affect `dualRepHubs` (kept for backward compatibility) or the
 *        `overlapKpis` counts.
 *
 * @returns {Object} Existing fields (paralympicRanking, balancedRanking,
 *   dualRepStates, dualRepHubs, paralympicSports, minAthletes) plus:
 *   - equalFrame: { olympic:{states,hubs,sports}, paralympic:{states,hubs,sports} }
 *       Side-by-side counts framed equally (no winner). `states`/`hubs` are
 *       distinct hometown_states/hometown_keys with >=1 athlete of the given
 *       sport_type (under the season filter); `sports` is distinct sports with
 *       that sport_type from stateSportSummary.
 *   - overlapKpis: { overlapStates, overlapHubs, overlapSports }
 *       Top-line totals. `overlapHubs` is the FULL count of dual-rep hubs
 *       (not capped at 25 like `dualRepHubs`).
 *   - representationHubs: top-25 hubs (by total_athletes) matching the
 *       `representation` filter, same shape as `dualRepHubs`.
 */
export function getParityLensData({ season = null, minAthletes = PARITY_MIN_DENOMINATOR, representation = 'all' } = {}) {
  const stateRows = filterStateRowsBySeason(season);
  const hubRows   = tallyHometownsBySeason(season);

  const paralympicRanking = stateRows
    .slice()
    .sort((a, b) => b.paralympic_athletes - a.paralympic_athletes)
    .slice(0, 15)
    .map((r) => ({ state: r.state, name: STATE_NAMES[r.state] || r.state, paralympic_athletes: r.paralympic_athletes, total: r.total_athletes, paralympic_share: r.paralympic_share, balance_index: r.balance_index }));

  // "Highest Paralympic share" among states with a meaningful denominator.
  // True 50/50 balance is unrealistic for Olympic/Paralympic rosters (Paralympic
  // athletes are a smaller absolute population in every state), so we surface
  // the states whose mix is *most* Paralympic-leaning above a size floor.
  const balancedRanking = stateRows
    .filter((r) => r.total_athletes >= minAthletes)
    .slice()
    .sort((a, b) => b.paralympic_share - a.paralympic_share)
    .slice(0, 15)
    .map((r) => ({ state: r.state, name: STATE_NAMES[r.state] || r.state, paralympic_share: r.paralympic_share, balance_index: r.balance_index, paralympic: r.paralympic_athletes, total: r.total_athletes }));

  const dualRepStates = stateRows
    .filter((r) => r.olympic_athletes > 0 && r.paralympic_athletes > 0)
    .slice()
    .sort((a, b) => b.total_athletes - a.total_athletes)
    .map((r) => ({ state: r.state, name: STATE_NAMES[r.state] || r.state, olympic: r.olympic_athletes, paralympic: r.paralympic_athletes, total: r.total_athletes }));

  const dualRepHubs = hubRows
    .filter((r) => r.olympic_athletes > 0 && r.paralympic_athletes > 0)
    .slice()
    .sort((a, b) => b.total_athletes - a.total_athletes)
    .slice(0, 25)
    .map((r) => ({ city: r.hometown_city, state: r.hometown_state, key: r.hometown_key, olympic: r.olympic_athletes, paralympic: r.paralympic_athletes, total: r.total_athletes }));

  // Sports with paralympic representation. Derive from participation rows so
  // `athletes` is a true distinct-athlete count per sport (not a sum of
  // pre-aggregated state_sport_summary.athlete_count, which would over-count
  // any athlete competing in multiple states for the same Paralympic sport).
  const paralympicSports = (() => {
    const map = new Map();
    const store = getStore();
    for (const r of store.participation) {
      if (r.sport_type !== 'Paralympic') continue;
      if (!bypass(season) && r.season !== season) continue;
      const cur = map.get(r.sport) || { sport: r.sport, season: r.season, athletes: new Set(), states: new Set() };
      cur.athletes.add(r.athlete_id);
      if (r.hometown_state) cur.states.add(r.hometown_state);
      map.set(r.sport, cur);
    }
    return Array.from(map.values())
      .map((r) => ({ sport: r.sport, season: r.season, athletes: r.athletes.size, states: r.states.size }))
      .sort((a, b) => b.athletes - a.athletes);
  })();

  // Equal-frame counts: distinct states/hubs with >=1 athlete of each type,
  // plus distinct sports per type from stateSportSummary. No winner framing.
  const equalFrame = (() => {
    const oly = { states: 0, hubs: 0, sports: 0 };
    const para = { states: 0, hubs: 0, sports: 0 };
    for (const r of stateRows) {
      if (r.olympic_athletes > 0) oly.states += 1;
      if (r.paralympic_athletes > 0) para.states += 1;
    }
    for (const r of hubRows) {
      if (r.olympic_athletes > 0) oly.hubs += 1;
      if (r.paralympic_athletes > 0) para.hubs += 1;
    }
    const olySports = new Set();
    const paraSports = new Set();
    for (const r of getStore().stateSportSummary) {
      if (!bypass(season) && r.season !== season) continue;
      if (r.sport_type === 'Olympic') olySports.add(r.sport);
      else if (r.sport_type === 'Paralympic') paraSports.add(r.sport);
    }
    oly.sports = olySports.size;
    para.sports = paraSports.size;
    return { olympic: oly, paralympic: para };
  })();

  // Overlap KPIs: full (uncapped) counts for top-line display.
  const overlapKpis = {
    overlapStates: dualRepStates.length,
    overlapHubs: hubRows.filter((r) => r.olympic_athletes > 0 && r.paralympic_athletes > 0).length,
    overlapSports: paralympicSports.length,
  };

  // representationHubs: hubs filtered by the `representation` parameter,
  // sorted by total athletes and capped at 25 (same shape as dualRepHubs).
  const repPredicate = (r) => {
    if (representation === 'oly_only')  return r.olympic_athletes > 0 && r.paralympic_athletes === 0;
    if (representation === 'para_only') return r.paralympic_athletes > 0 && r.olympic_athletes === 0;
    if (representation === 'both')      return r.olympic_athletes > 0 && r.paralympic_athletes > 0;
    return r.total_athletes > 0;
  };
  const representationHubs = hubRows
    .filter(repPredicate)
    .slice()
    .sort((a, b) => b.total_athletes - a.total_athletes)
    .slice(0, 25)
    .map((r) => ({ city: r.hometown_city, state: r.hometown_state, key: r.hometown_key, olympic: r.olympic_athletes, paralympic: r.paralympic_athletes, total: r.total_athletes }));

  return { paralympicRanking, balancedRanking, dualRepStates, dualRepHubs, paralympicSports, minAthletes, equalFrame, overlapKpis, representationHubs };
}

/**
 * Paralympic Sport Footprint — one row per Paralympic-flagged sport with the
 * total athletes, distinct states represented (>=1 Paralympic athlete in that
 * sport), and distinct hometown hubs represented. Derived from participation
 * rows where `sport_type === 'Paralympic'`, so the counts match the rest of
 * the Parity Lens (which also uses sport_type, not has_para_classification).
 *
 * @param {Object}  [opts]
 * @param {?string} [opts.season] Season filter ('Summer'|'Winter'|null/'all').
 * @returns {Array<{sport:string, athletes:number, states:number, hubs:number}>}
 *          Sorted by athlete count desc.
 */
export function getParalympicSportFootprint({ season = null } = {}) {
  const seasoned = !bypass(season);
  const tally = new Map();
  for (const r of getStore().participation) {
    if (r.sport_type !== 'Paralympic') continue;
    if (seasoned && r.season !== season) continue;
    if (!r.sport) continue;
    const cur = tally.get(r.sport) || {
      sport: r.sport,
      athletes: new Set(),
      states: new Set(),
      hubs: new Set(),
    };
    cur.athletes.add(r.athlete_id);
    if (r.hometown_state) cur.states.add(r.hometown_state);
    if (r.hometown_key)   cur.hubs.add(r.hometown_key);
    tally.set(r.sport, cur);
  }
  return Array.from(tally.values())
    .map((t) => ({
      sport: t.sport,
      athletes: t.athletes.size,
      states: t.states.size,
      hubs: t.hubs.size,
    }))
    .sort((a, b) => b.athletes - a.athletes || a.sport.localeCompare(b.sport));
}

/**
 * Filter a list of hub rows (same shape as `representationHubs` or
 * `dualRepHubs`) to those with at least one Olympic AND one Paralympic
 * athlete. Pure helper kept here so the page module stays render-only.
 */
export function filterBothProgramHubs(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => (r.olympic || 0) > 0 && (r.paralympic || 0) > 0);
}
