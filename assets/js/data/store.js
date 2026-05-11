/**
 * Team USA Atlas — central store
 *
 * Singleton holding the loaded data plus shared constants. Pages and helpers
 * import getStore() (or the constants) instead of touching globals. Initialised
 * exactly once during boot in main.js via initStore().
 *
 * Constants (PROGRAMS, SEASONS, STATE_NAMES) are *derived from the loaded JSON*
 * at boot — never hardcoded against assumptions about what the data should look
 * like. The fallback maps below only kick in for codes the data doesn't expose.
 */

import { loadAll } from './loader.js';

let _store = null;

// Fallback display labels for state codes the loaded data doesn't carry a
// human-readable name for (e.g. DC/HI/VI are absent from NOAA climate). These
// are the only hardcoded display strings in the app — every numeric value still
// comes from the loaded JSON files.
const STATE_NAME_FALLBACK = {
  DC: 'District of Columbia',
  HI: 'Hawaii',
  VI: 'U.S. Virgin Islands',
};

// Mutable, populated during initStore from climate_state_summary + fallback.
export let STATE_NAMES = { ...STATE_NAME_FALLBACK };

// Derived from the data at boot. Re-exported as `let` so getDerivedEnums() can
// rewrite them on init. Default to the canonical contract values so anything
// imported before initStore (during module setup) gets a sensible shape.
export let PROGRAMS = ['Olympic', 'Paralympic'];
export let SEASONS  = ['Summer',  'Winter'];

export const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

export const RAMP_STOPS = [
  { stop: 0.00, color: '#EAF2FB' },
  { stop: 0.20, color: '#C7DBF2' },
  { stop: 0.40, color: '#94BAE3' },
  { stop: 0.60, color: '#5E94CC' },
  { stop: 0.80, color: '#346BB0' },
  { stop: 1.00, color: '#173F7E' },
];

export const PARITY_MIN_DENOMINATOR = 30;

function deriveStateNames(data) {
  const map = { ...STATE_NAME_FALLBACK };
  // climate_state_summary carries the only state_name column in the corpus
  for (const r of data.climate || []) {
    if (r.state && r.state_name) map[r.state] = r.state_name;
  }
  // Anything appearing in the data that we still don't have a label for falls
  // back to the bare code so the UI never shows blanks.
  const allCodes = new Set([
    ...(data.stateSummary || []).map((r) => r.state),
    ...(data.participation || []).map((r) => r.hometown_state),
    ...(data.climate || []).map((r) => r.state),
  ]);
  for (const code of allCodes) {
    if (code && !map[code]) map[code] = code;
  }
  return map;
}

function deriveEnums(data) {
  const programs = new Set();
  const seasons  = new Set();
  for (const r of data.participation || []) {
    if (r.sport_type) programs.add(r.sport_type);
    if (r.season)     seasons.add(r.season);
  }
  // Stable ordering for UI: Olympic before Paralympic, Summer before Winter
  const orderedPrograms = ['Olympic', 'Paralympic'].filter((p) => programs.has(p))
    .concat([...programs].filter((p) => !['Olympic','Paralympic'].includes(p)).sort());
  const orderedSeasons = ['Summer', 'Winter'].filter((s) => seasons.has(s))
    .concat([...seasons].filter((s) => !['Summer','Winter'].includes(s)).sort());
  return {
    PROGRAMS: orderedPrograms.length ? orderedPrograms : PROGRAMS,
    SEASONS:  orderedSeasons.length  ? orderedSeasons  : SEASONS,
  };
}

export async function initStore() {
  if (_store) return _store;
  const data = await loadAll();
  // Derive enums + display labels from the loaded JSON.
  STATE_NAMES = deriveStateNames(data);
  const enums = deriveEnums(data);
  PROGRAMS = enums.PROGRAMS;
  SEASONS  = enums.SEASONS;
  _store = Object.freeze({
    ...data,
    PROGRAMS, SEASONS, STATE_NAMES,
    stateName: (st) => STATE_NAMES[st] || st,
  });
  return _store;
}

export function getStore() {
  if (!_store) {
    throw new Error('Store accessed before initStore() resolved. Call initStore() during boot.');
  }
  return _store;
}

export function isStoreReady() {
  return _store !== null;
}
