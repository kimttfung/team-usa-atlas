/**
 * helpers/topSports.js — single source of truth for "top sports for a state"
 * (and the national equivalent).
 *
 * Standardises the row shape that every page + the context builders consume:
 *   { sport, athletes, share, program }
 *     - sport:    canonical sport name
 *     - athletes: distinct athletes in this state-sport (or national-sport)
 *     - share:    fraction of the state's (or national) total roster (0..1)
 *     - program:  'Olympic' | 'Paralympic' | 'Both'
 *
 * Derived from `participation` so program/season filters honour the same
 * distinct-athlete contract as the rest of the helpers (see aggregates.js
 * `getTopSportsScoped`). Memoised per `(stateCode, JSON.stringify(opts))`.
 */

import { getStore } from '../data/store.js';
import { matchFilters } from './filters.js';

/**
 * @typedef {Object} TopSportEntry
 * @property {string} sport
 * @property {number} athletes
 * @property {number} share
 * @property {string} program   // 'Olympic' | 'Paralympic' | 'Both'
 */

const _stateCache = new Map();
const _nationalCache = new Map();

function normaliseProgram(p) {
  if (!p) return null;
  if (p === 'both' || p === 'All' || p === 'all') return null;
  return p;
}

function classifyProgram(hasOly, hasPara) {
  if (hasOly && hasPara) return 'Both';
  if (hasPara) return 'Paralympic';
  return 'Olympic';
}

function computeTopSports({ state = null, program = null, season = null, limit = 10 }) {
  const prog = normaliseProgram(program);
  const ids = new Map();         // sport -> Set<athlete_id>
  const olyIds = new Map();      // sport -> Set<athlete_id> with Olympic row
  const paraIds = new Map();     // sport -> Set<athlete_id> with Paralympic row
  const stateIds = new Set();    // distinct athletes in the (state, filters) scope
  for (const r of getStore().participation) {
    if (!matchFilters(r, { state, program: prog, season })) continue;
    if (!r.sport) continue;
    stateIds.add(r.athlete_id);
    let bag = ids.get(r.sport);
    if (!bag) { bag = new Set(); ids.set(r.sport, bag); }
    bag.add(r.athlete_id);
    if (r.sport_type === 'Olympic') {
      let o = olyIds.get(r.sport);
      if (!o) { o = new Set(); olyIds.set(r.sport, o); }
      o.add(r.athlete_id);
    } else if (r.sport_type === 'Paralympic') {
      let p = paraIds.get(r.sport);
      if (!p) { p = new Set(); paraIds.set(r.sport, p); }
      p.add(r.athlete_id);
    }
  }
  const total = stateIds.size;
  const rows = Array.from(ids.entries()).map(([sport, set]) => ({
    sport,
    athletes: set.size,
    share: total ? set.size / total : 0,
    program: classifyProgram((olyIds.get(sport)?.size || 0) > 0, (paraIds.get(sport)?.size || 0) > 0),
  }));
  rows.sort((a, b) => (b.athletes - a.athletes) || a.sport.localeCompare(b.sport));
  return rows.slice(0, limit);
}

/**
 * Top sports for a single state.
 *
 * @param {string} stateCode
 * @param {{ limit?: number, program?: 'Olympic'|'Paralympic'|'both', season?: 'Summer'|'Winter'|null }} [opts]
 * @returns {TopSportEntry[]}
 */
export function getTopSportsForState(stateCode, opts = {}) {
  if (!stateCode) return [];
  const limit = typeof opts.limit === 'number' ? opts.limit : 10;
  const key = `${stateCode}::${JSON.stringify({ limit, program: opts.program || null, season: opts.season || null })}`;
  const cached = _stateCache.get(key);
  if (cached) return cached;
  const rows = computeTopSports({
    state: stateCode,
    program: opts.program || null,
    season: opts.season || null,
    limit,
  });
  _stateCache.set(key, rows);
  return rows;
}

/**
 * Top sports across the whole national roster.
 *
 * @param {{ limit?: number, program?: 'Olympic'|'Paralympic'|'both', season?: 'Summer'|'Winter'|null }} [opts]
 * @returns {TopSportEntry[]}
 */
export function getTopSportsNational(opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 10;
  const key = JSON.stringify({ limit, program: opts.program || null, season: opts.season || null });
  const cached = _nationalCache.get(key);
  if (cached) return cached;
  const rows = computeTopSports({
    state: null,
    program: opts.program || null,
    season: opts.season || null,
    limit,
  });
  _nationalCache.set(key, rows);
  return rows;
}
