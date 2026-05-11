/**
 * helpers/filters.js — single source of truth for the global filter contract
 *
 * Filter shape used everywhere:
 *   { state?: string, sport?: string, program?: 'Olympic'|'Paralympic'|'All', season?: 'Summer'|'Winter'|'All' }
 *
 * Empty / null / 'All' all mean "no constraint".
 */

import { getStore } from '../data/store.js';

function bypass(value) {
  return value === null || value === undefined || value === ''
    || value === 'All' || value === 'all'
    || value === 'Any' || value === 'any';
}

export function matchFilters(row, { state, sport, program, season }) {
  if (!bypass(state)   && row.hometown_state !== state) return false;
  if (!bypass(sport)   && row.sport          !== sport) return false;
  if (!bypass(program) && row.sport_type     !== program) return false;
  if (!bypass(season)  && row.season         !== season) return false;
  return true;
}

export function getFilteredParticipation(opts = {}) {
  return getStore().participation.filter((r) => matchFilters(r, opts));
}

/**
 * Single-state metric used by the Atlas map under the current filter combo.
 * Returns the count of distinct athletes from `state` who match all filters.
 */
export function computeStateValueByFilters(state, filters = {}) {
  if (!state) return 0;
  const rows = getStore().participation.filter((r) =>
    r.hometown_state === state && matchFilters(r, { ...filters, state: null })
  );
  if (bypass(filters.sport) && bypass(filters.program) && bypass(filters.season)) {
    // Fast path: equivalent to the precomputed state_summary total.
    const summary = getStore().stateSummary.find((s) => s.state === state);
    return summary ? summary.total_athletes : new Set(rows.map((r) => r.athlete_id)).size;
  }
  return new Set(rows.map((r) => r.athlete_id)).size;
}

/**
 * Build a { stateCode → value } map for the entire country under the current filters.
 * Used by the Atlas map to color states in one pass.
 */
export function buildStateValueMap(filters = {}) {
  const out = {};
  for (const r of getStore().stateSummary) out[r.state] = 0;

  if (bypass(filters.sport) && bypass(filters.program) && bypass(filters.season)) {
    for (const r of getStore().stateSummary) out[r.state] = r.total_athletes;
    return out;
  }

  // Distinct athletes per state matching filters
  const seenByState = {};
  for (const r of getStore().participation) {
    if (!matchFilters(r, { ...filters, state: null })) continue;
    const st = r.hometown_state;
    if (!st) continue;
    if (!seenByState[st]) seenByState[st] = new Set();
    seenByState[st].add(r.athlete_id);
  }
  for (const st of Object.keys(seenByState)) out[st] = seenByState[st].size;
  return out;
}
