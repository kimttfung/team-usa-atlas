/**
 * helpers/aggregates.js — national + cross-cutting rankings & splits
 *
 * Splits are returned as { olympic, paralympic, total } and { summer, winter, total }
 * so callers can format them however they want (counts, percentages, bars).
 *
 * Source of truth:
 *   - athletes_clean → unique athlete count (canonical: 4,705)
 *   - participation  → for any filter that mixes program/season/sport/state
 *   - state_summary  → fast path for unfiltered state aggregates only (its
 *                      pre-aggregated columns disagree with athletes_clean by
 *                      ~91 athletes due to dual-classification handling, so we
 *                      ONLY trust it when no filter is active and the caller
 *                      explicitly opts into "snapshot" semantics).
 *
 * "scope" parameter accepts:
 *   { kind: 'national' }
 *   { kind: 'state',   state }
 *   { kind: 'sport',   sport, program?, season? }
 */

import { getStore, STATE_NAMES } from '../data/store.js';
import { matchFilters } from './filters.js';

export function getNationalTotal() {
  // Canonical count of unique athletes — read from athletes_clean, not from
  // state_summary aggregates (which double-count dual-classified athletes
  // across olympic/paralympic columns).
  return getStore().athletes.length;
}

export function getShareOfNational(st, filters = null) {
  if (filters) {
    const stTot = getScopedStateTotals(st, filters).total;
    const natTot = getScopedNationalTotals(filters).total;
    return natTot ? stTot / natTot : 0;
  }
  const total = getNationalTotal();
  if (!total) return 0;
  const row = getStore().stateSummary.find((r) => r.state === st);
  return row ? row.total_athletes / total : 0;
}

const NUMERIC_METRICS = new Set([
  'total_athletes', 'olympic_athletes', 'paralympic_athletes',
  'summer_athletes', 'winter_athletes', 'sport_count', 'parity_ratio',
]);

export function getTopStates(metric, limit = 10) {
  if (!NUMERIC_METRICS.has(metric)) {
    throw new Error(`getTopStates: unsupported metric "${metric}"`);
  }
  return getStore()
    .stateSummary
    .slice()
    .sort((a, b) => (b[metric] || 0) - (a[metric] || 0))
    .slice(0, limit)
    .map((r) => ({ ...r, name: STATE_NAMES[r.state] || r.state }));
}

export function getTopHometowns(limit = 10) {
  return getStore()
    .hometownSummary
    .slice()
    .sort((a, b) => b.total_athletes - a.total_athletes)
    .slice(0, limit);
}

/**
 * Top sports nationally by total athlete_count across all states.
 */
export function getTopSports(limit = 10) {
  const map = new Map();
  for (const r of getStore().stateSportSummary) {
    const cur = map.get(r.sport) || { sport: r.sport, season: r.season, sportType: r.sport_type, athletes: 0, states: new Set() };
    cur.athletes += r.athlete_count;
    cur.states.add(r.state);
    map.set(r.sport, cur);
  }
  return Array.from(map.values())
    .map((row) => ({ sport: row.sport, season: row.season, sportType: row.sportType, athletes: row.athletes, states: row.states.size }))
    .sort((a, b) => b.athletes - a.athletes)
    .slice(0, limit);
}

/**
 * Sport diversity ranking: states with the highest sport_count.
 */
export function getSportDiversityRankings(limit = 10) {
  return getStore()
    .stateSummary
    .slice()
    .sort((a, b) => b.sport_count - a.sport_count)
    .slice(0, limit)
    .map((r) => ({ state: r.state, name: STATE_NAMES[r.state] || r.state, sport_count: r.sport_count, total_athletes: r.total_athletes }));
}

function reducePart(rows, predicate) {
  let count = 0;
  const seen = new Set();
  for (const r of rows) {
    if (!predicate(r)) continue;
    if (seen.has(r.athlete_id)) continue;
    seen.add(r.athlete_id);
    count += 1;
  }
  return count;
}

function rowsForScope(scope) {
  const store = getStore();
  if (!scope || scope.kind === 'national') return store.participation;
  if (scope.kind === 'state') return store.participation.filter((r) => r.hometown_state === scope.state);
  if (scope.kind === 'sport') {
    return store.participation.filter((r) => matchFilters(r, {
      sport: scope.sport, program: scope.program, season: scope.season,
    }));
  }
  return store.participation;
}

// Returns distinct-athlete counts per program. `splitSum` is the literal
// sum of the two buckets — NOT the distinct-athlete total for the scope, since
// the same athlete can appear in both Olympic and Paralympic participation
// rows. For the distinct total use getScopedStateTotals/getScopedNationalTotals
// instead.
export function getOlyParaSplit(scope = { kind: 'national' }) {
  const rows = rowsForScope(scope);
  const olympic     = reducePart(rows, (r) => r.sport_type === 'Olympic');
  const paralympic  = reducePart(rows, (r) => r.sport_type === 'Paralympic');
  return { olympic, paralympic, splitSum: olympic + paralympic };
}

// Returns distinct-athlete counts per season. `splitSum` is the literal sum
// of summer + winter and is NOT a distinct-athlete total for the scope — see
// getOlyParaSplit's note.
export function getSummerWinterSplit(scope = { kind: 'national' }) {
  const rows = rowsForScope(scope);
  const summer = reducePart(rows, (r) => r.season === 'Summer');
  const winter = reducePart(rows, (r) => r.season === 'Winter');
  return { summer, winter, splitSum: summer + winter };
}

/**
 * Sum of athlete_count for {state, sport} from state_sport_summary,
 * narrowed by optional program (sport_type) and season filters.
 */
export function getStateSportTotals(state, sport, { program = null, season = null } = {}) {
  if (!state || !sport) return { athletes: 0, paralympic: 0, olympic: 0, rowCount: 0 };
  let athletes = 0, paralympic = 0, olympic = 0, rowCount = 0;
  for (const r of getStore().stateSportSummary) {
    if (r.state !== state) continue;
    if (r.sport !== sport) continue;
    if (program && r.sport_type !== program) continue;
    if (season  && r.season     !== season)  continue;
    athletes += (r.athlete_count || 0);
    if (r.sport_type === 'Paralympic') paralympic += (r.athlete_count || 0);
    if (r.sport_type === 'Olympic')    olympic    += (r.athlete_count || 0);
    rowCount += 1;
  }
  return { athletes, paralympic, olympic, rowCount };
}

/**
 * Nationwide athletes-in-sport total derived from state_sport_summary,
 * narrowed by optional program (sport_type) and season filters.
 */
export function getNationalSportTotals(sport, { program = null, season = null } = {}) {
  if (!sport) return { athletes: 0, paralympic: 0, olympic: 0 };
  let athletes = 0, paralympic = 0, olympic = 0;
  for (const r of getStore().stateSportSummary) {
    if (r.sport !== sport) continue;
    if (program && r.sport_type !== program) continue;
    if (season  && r.season     !== season)  continue;
    athletes += (r.athlete_count || 0);
    if (r.sport_type === 'Paralympic') paralympic += (r.athlete_count || 0);
    if (r.sport_type === 'Olympic')    olympic    += (r.athlete_count || 0);
  }
  return { athletes, paralympic, olympic };
}

/**
 * The single helper every page should call when ANY filter combination is in
 * play. Returns a fully-scoped, internally-consistent breakdown of the unique
 * athlete population matching {state, sport, program, season}.
 *
 * Counts are always over distinct athlete_id (so dual-classified athletes are
 * counted once per unique row) — no double counting.
 *
 * Returns:
 *   {
 *     total: number,        // distinct athletes matching ALL filters
 *     olympic, paralympic,  // splits within total (sum may exceed total iff an
 *                              athlete has both classifications in scope)
 *     summer, winter,       // season splits within total
 *     sportCount: number,   // distinct sports matched (post-filter)
 *     paralympicShare: number, // paralympic / total — composition metric
 *     balanceIndex: number,    // min(oly,para) / max(oly,para) — symmetry score, 0..1
 *     filters: {…}             // echoed back for label rendering
 *   }
 */
export function getScopedStateTotals(state, filters = {}) {
  const { sport = null, program = null, season = null } = filters;
  const rows = getStore().participation.filter((r) =>
    r.hometown_state === state &&
    matchFilters(r, { sport, program, season })
  );
  return summarizeRows(rows, { state, sport, program, season });
}

export function getScopedNationalTotals(filters = {}) {
  const { sport = null, program = null, season = null } = filters;
  // Hot path: nothing filtered → use canonical athlete count for total + sportCount,
  // but compute Olympic/Paralympic/Summer/Winter splits from participation so that
  // every page uses ONE consistent definition of "Paralympic athletes" =
  // "athletes with ≥1 participation row of sport_type='Paralympic'".
  if (!sport && !program && !season) {
    const store = getStore();
    const total = store.athletes.length;
    const olySet = new Set();
    const paraSet = new Set();
    const sumSet = new Set();
    const winSet = new Set();
    for (const r of store.participation) {
      if (r.sport_type === 'Olympic')    olySet.add(r.athlete_id);
      if (r.sport_type === 'Paralympic') paraSet.add(r.athlete_id);
      if (r.season === 'Summer') sumSet.add(r.athlete_id);
      if (r.season === 'Winter') winSet.add(r.athlete_id);
    }
    const sportCount = new Set(store.participation.map((r) => r.sport)).size;
    const paralympic = paraSet.size;
    const olympic = olySet.size;
    const minProg = Math.min(olympic, paralympic);
    const maxProg = Math.max(olympic, paralympic);
    return {
      total,
      olympic,
      paralympic,
      summer: sumSet.size,
      winter: winSet.size,
      sportCount,
      paralympicShare: total ? paralympic / total : 0,
      balanceIndex: maxProg ? minProg / maxProg : 0,
      filters: { sport, program, season },
    };
  }
  const rows = getStore().participation.filter((r) =>
    matchFilters(r, { sport, program, season })
  );
  return summarizeRows(rows, { state: null, sport, program, season });
}

function summarizeRows(rows, filters) {
  const ids = new Set();
  const olyIds = new Set();
  const paraIds = new Set();
  const sumIds = new Set();
  const winIds = new Set();
  const sports = new Set();
  for (const r of rows) {
    ids.add(r.athlete_id);
    if (r.sport_type === 'Olympic')    olyIds.add(r.athlete_id);
    if (r.sport_type === 'Paralympic') paraIds.add(r.athlete_id);
    if (r.season === 'Summer') sumIds.add(r.athlete_id);
    if (r.season === 'Winter') winIds.add(r.athlete_id);
    if (r.sport) sports.add(r.sport);
  }
  const total = ids.size;
  const olympic = olyIds.size;
  const paralympic = paraIds.size;
  const minProg = Math.min(olympic, paralympic);
  const maxProg = Math.max(olympic, paralympic);
  return {
    total,
    olympic,
    paralympic,
    summer: sumIds.size,
    winter: winIds.size,
    sportCount: sports.size,
    paralympicShare: total ? paralympic / total : 0,
    balanceIndex: maxProg ? minProg / maxProg : 0,
    filters,
  };
}

/**
 * One-pass per-state aggregation from participation. Returns a Map keyed by
 * state code where each value is `{ total, olympic, paralympic, summer,
 * winter, sportCount, paralympicShare, balanceIndex }` — the same shape as
 * getScopedStateTotals, just for every state at once. Used by the Atlas map,
 * Parity Lens, and Ask the Analyst so they share one definition of every count.
 *
 * filters: { sport?, program?, season? } — anything that getScopedStateTotals
 * accepts. Counts are always over distinct athlete_id within each state.
 */
export function getStateAggregateMap(filters = {}) {
  const { sport = null, program = null, season = null } = filters;
  const byState = new Map();
  const ensure = (st) => {
    let cur = byState.get(st);
    if (!cur) {
      cur = { state: st, ids: new Set(), oly: new Set(), para: new Set(), sum: new Set(), win: new Set(), sports: new Set() };
      byState.set(st, cur);
    }
    return cur;
  };
  for (const r of getStore().participation) {
    if (!matchFilters(r, { sport, program, season })) continue;
    if (!r.hometown_state) continue;
    const cur = ensure(r.hometown_state);
    cur.ids.add(r.athlete_id);
    if (r.sport_type === 'Olympic')    cur.oly.add(r.athlete_id);
    if (r.sport_type === 'Paralympic') cur.para.add(r.athlete_id);
    if (r.season === 'Summer') cur.sum.add(r.athlete_id);
    if (r.season === 'Winter') cur.win.add(r.athlete_id);
    if (r.sport) cur.sports.add(r.sport);
  }
  // Make sure every state in stateSummary appears (even with zero) so map
  // colorings have a consistent set of keys to choose from.
  for (const r of getStore().stateSummary) ensure(r.state);

  const out = new Map();
  for (const [st, cur] of byState) {
    const total = cur.ids.size;
    const olympic = cur.oly.size;
    const paralympic = cur.para.size;
    const minProg = Math.min(olympic, paralympic);
    const maxProg = Math.max(olympic, paralympic);
    out.set(st, {
      state: st,
      total,
      olympic,
      paralympic,
      summer: cur.sum.size,
      winter: cur.win.size,
      sportCount: cur.sports.size,
      paralympicShare: total ? paralympic / total : 0,
      balanceIndex: maxProg ? minProg / maxProg : 0,
    });
  }
  return out;
}

/**
 * Top hometown hubs under filters. Distinct athletes per hometown_key from
 * participation. Used by Atlas + Ask when program/season/sport are active.
 */
export function getTopHometownsScoped(filters = {}, limit = 10) {
  const { sport = null, program = null, season = null, state = null } = filters;
  const ids  = new Map();
  const oly  = new Map();
  const para = new Map();
  const meta = new Map();
  for (const r of getStore().participation) {
    if (!matchFilters(r, { sport, program, season, state })) continue;
    if (!r.hometown_key) continue;
    if (!ids.has(r.hometown_key)) {
      ids.set(r.hometown_key, new Set());
      oly.set(r.hometown_key, new Set());
      para.set(r.hometown_key, new Set());
      meta.set(r.hometown_key, { city: r.hometown_city, state: r.hometown_state, key: r.hometown_key });
    }
    ids.get(r.hometown_key).add(r.athlete_id);
    if (r.sport_type === 'Olympic')    oly.get(r.hometown_key).add(r.athlete_id);
    if (r.sport_type === 'Paralympic') para.get(r.hometown_key).add(r.athlete_id);
  }
  return Array.from(ids.entries())
    .map(([k, set]) => ({
      hometown_key: k,
      hometown_city: meta.get(k).city,
      hometown_state: meta.get(k).state,
      total_athletes: set.size,
      olympic_athletes: oly.get(k).size,
      paralympic_athletes: para.get(k).size,
    }))
    .sort((a, b) => b.total_athletes - a.total_athletes)
    .slice(0, limit);
}

/**
 * Top-N hometown bubbles for the map. Joins the scoped top-hometowns ranking
 * with hometown_geo.json (city → SVG x,y) so the map can drop circles. Geo
 * lookup uses hometown_key. Hometowns missing from hometown_geo.json (rare —
 * mostly tiny places, ~4% of the long tail) are skipped silently; they simply
 * won't get a bubble.
 *
 * Returns: [{ hometown_key, hometown_city, hometown_state, total_athletes, x, y }]
 */
export function getTopHometownBubbles(filters = {}, limit = 10) {
  const top = getTopHometownsScoped(filters, limit);
  if (!top.length) return [];
  const geoIdx = getStore().hometownGeo || [];
  const byKey = new Map(geoIdx.map((g) => [g.hometown_key, g]));
  const out = [];
  for (const h of top) {
    const g = byKey.get(h.hometown_key);
    if (!g || g.x == null || g.y == null) continue;
    out.push({
      hometown_key: h.hometown_key,
      hometown_city: h.hometown_city,
      hometown_state: h.hometown_state,
      total_athletes: h.total_athletes,
      olympic_athletes: h.olympic_athletes,
      paralympic_athletes: h.paralympic_athletes,
      x: g.x,
      y: g.y,
    });
  }
  return out;
}

/**
 * Top sports under filters. Distinct athletes per sport from participation.
 * If `state` is set, restricts to that state; otherwise national.
 */
export function getTopSportsScoped(filters = {}, limit = 10) {
  const { state = null, program = null, season = null } = filters;
  const ids = new Map();
  const meta = new Map();
  for (const r of getStore().participation) {
    if (!matchFilters(r, { state, program, season })) continue;
    if (!r.sport) continue;
    if (!ids.has(r.sport)) {
      ids.set(r.sport, new Set());
      meta.set(r.sport, { sport: r.sport, season: r.season, sportType: r.sport_type });
    }
    ids.get(r.sport).add(r.athlete_id);
  }
  return Array.from(ids.entries())
    .map(([sport, set]) => ({ sport, athlete_count: set.size, athletes: set.size, ...meta.get(sport) }))
    .sort((a, b) => b.athletes - a.athletes)
    .slice(0, limit);
}


/**
 * Hometown concentration within a state.
 *
 * Returns the top-N hometown hubs in `state` (by total_athletes) along with
 * their combined share of the state's total athletes. Useful for measuring how
 * concentrated a state's Team USA representation is in a few cities.
 */
export function getHometownConcentration(state, n = 3) {
  if (!state) {
    return { state, topHubs: [], topNShare: 0, topNCount: 0, stateTotal: 0, sumOfTop: 0 };
  }
  const store = getStore();
  const hubs = (store.hometownSummary || [])
    .filter((r) => r.hometown_state === state)
    .sort((a, b) => b.total_athletes - a.total_athletes)
    .slice(0, n);
  const topHubs = hubs.map((r) => ({
    city: r.hometown_city,
    state: r.hometown_state,
    hometown_key: r.hometown_key,
    athletes: r.total_athletes,
  }));
  const sumOfTop = topHubs.reduce((acc, h) => acc + (h.athletes || 0), 0);
  const stateTotal = (store.stateSummary || []).find((r) => r.state === state)?.total_athletes || 0;
  const topNShare = stateTotal > 0 ? sumOfTop / stateTotal : 0;
  return {
    state,
    topHubs,
    topNShare,
    topNCount: topHubs.length,
    stateTotal,
    sumOfTop,
  };
}
