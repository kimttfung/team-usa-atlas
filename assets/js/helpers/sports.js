/**
 * helpers/sports.js — sport-scoped lookups
 *
 * "program" filter ('Olympic' | 'Paralympic') maps to row.sport_type.
 * "season"  filter ('Summer'  | 'Winter')     maps to row.season.
 * Pass null/undefined/'All' to bypass either filter.
 */

import { getStore, STATE_NAMES } from '../data/store.js';

function matchProgram(row, program) {
  if (!program || program === 'All') return true;
  return row.sport_type === program;
}

function matchSeason(row, season) {
  if (!season || season === 'All') return true;
  return row.season === season;
}

export function getAllSports() {
  const set = new Set();
  for (const r of getStore().stateSportSummary) set.add(r.sport);
  return Array.from(set).sort();
}

export function getSportOptions() {
  return getAllSports().map((s) => ({ value: s, label: s }));
}

/**
 * Resolve a sport name to the array of sport names that should be queried.
 * When `combinePara` is true and the sport has a Para sibling (or is itself a
 * Para variant of an Olympic sport), both names are returned so callers can
 * aggregate Olympic + Paralympic disciplines together.
 *
 *   getSportPair('Track and Field', true)       -> ['Track and Field', 'Para Track and Field']
 *   getSportPair('Para Track and Field', true)  -> ['Track and Field', 'Para Track and Field']
 *   getSportPair('Para Powerlifting', true)     -> ['Para Powerlifting']  (no Olympic sibling)
 *   getSportPair('Track and Field', false)      -> ['Track and Field']
 */
export function getSportPair(sport, combinePara = false) {
  if (!sport) return [];
  if (!combinePara) return [sport];
  const all = new Set();
  for (const r of getStore().stateSportSummary) all.add(r.sport);
  const isPara = sport.startsWith('Para ');
  const base = isPara ? sport.slice(5) : sport;
  const para = isPara ? sport : `Para ${sport}`;
  const out = [];
  if (all.has(base)) out.push(base);
  if (all.has(para)) out.push(para);
  return out.length ? out : [sport];
}

/**
 * True when the sport has both an Olympic and Paralympic variant in the data.
 */
export function hasParaSibling(sport) {
  if (!sport) return false;
  const pair = getSportPair(sport, true);
  return pair.length > 1;
}

/**
 * Picker options. When `combinePara` is true, sports with a Para sibling get a
 * "(+ Para)" hint and the Para variant itself is hidden so users see one entry
 * per "combined" discipline. When false, returns the raw 91 sport names.
 */
export function getSportPickerOptions(combinePara = false) {
  const sports = getAllSports();
  if (!combinePara) return sports.map((s) => ({ value: s, label: s }));
  const set = new Set(sports);
  const out = [];
  for (const s of sports) {
    if (s.startsWith('Para ') && set.has(s.slice(5))) continue; // hide Para sibling, surfaced via base
    if (!s.startsWith('Para ') && set.has(`Para ${s}`)) {
      out.push({ value: s, label: `${s} (+ Para)` });
    } else {
      out.push({ value: s, label: s });
    }
  }
  return out;
}

/**
 * Aggregate snapshot for a single sport, optionally narrowed by program/season.
 * Returns null if the sport doesn't exist in the data.
 *
 * NOTE: totals come from distinct athlete_ids in `athlete_participation_clean`
 * — not from summed `athlete_count` in `state_sport_summary`. Otherwise an
 * athlete who appears in both Olympic and Paralympic variants of a sport (when
 * combinePara=true) would be counted twice. State and hub breakdowns can still
 * use the per-state aggregate where double-counting doesn't apply.
 */
export function getSportSummary(sport, { program = null, season = null, combinePara = false } = {}) {
  if (!sport) return null;

  const sportNames = new Set(getSportPair(sport, combinePara));
  const sportRows = getStore().stateSportSummary.filter(
    (r) => sportNames.has(r.sport) && matchProgram(r, program) && matchSeason(r, season)
  );
  if (sportRows.length === 0) return null;

  const partRows = getStore().participation.filter(
    (r) => sportNames.has(r.sport) && matchProgram(r, program) && matchSeason(r, season)
  );

  // Distinct athlete totals from participation (no double-count across variants/states)
  const allIds = new Set();
  const olyIds = new Set();
  const paraIds = new Set();
  const stateAthletes = new Map(); // state -> Set<athlete_id>
  for (const r of partRows) {
    allIds.add(r.athlete_id);
    if (r.sport_type === 'Olympic')    olyIds.add(r.athlete_id);
    if (r.sport_type === 'Paralympic') paraIds.add(r.athlete_id);
    if (r.hometown_state) {
      let bag = stateAthletes.get(r.hometown_state);
      if (!bag) { bag = new Set(); stateAthletes.set(r.hometown_state, bag); }
      bag.add(r.athlete_id);
    }
  }
  const totalAthletes = allIds.size;
  const olympic = olyIds.size;
  const paralympic = paraIds.size;
  const states = new Set(sportRows.map((r) => r.state));

  const stateTotals = Array.from(stateAthletes.entries()).map(([s, set]) => [s, set.size]);
  const topEntry = stateTotals.sort((a, b) => b[1] - a[1])[0] || null;
  const top = topEntry ? { state: topEntry[0], athleteCount: topEntry[1] } : null;

  // Hometown hubs: distinct athletes per hometown_key
  const hubAthletes = new Map();
  const hubMeta = new Map();
  for (const r of partRows) {
    if (!r.hometown_key) continue;
    let bag = hubAthletes.get(r.hometown_key);
    if (!bag) { bag = new Set(); hubAthletes.set(r.hometown_key, bag); }
    bag.add(r.athlete_id);
    if (!hubMeta.has(r.hometown_key)) hubMeta.set(r.hometown_key, { city: r.hometown_city, state: r.hometown_state });
  }
  const hubEntries = Array.from(hubAthletes.entries())
    .map(([key, ids]) => ({ key, count: ids.size, ...(hubMeta.get(key) || {}) }))
    .sort((a, b) => b.count - a.count);
  const topHub = hubEntries[0] || null;

  const seasonValues = Array.from(new Set(sportRows.map((r) => r.season)));
  const typeValues = Array.from(new Set(sportRows.map((r) => r.sport_type)));
  const combinedActive = combinePara && sportNames.size > 1;

  return {
    sport,
    sportNames: Array.from(sportNames),
    combined: combinedActive,
    totalAthletes,
    olympic,
    paralympic,
    statesRepresented: states.size,
    stateRowCount: sportRows.length,
    hubsRepresented: hubAthletes.size,
    topState: top ? { state: top.state, name: STATE_NAMES[top.state] || top.state, athletes: top.athleteCount, athleteCount: top.athleteCount } : null,
    topHometown: topHub ? { city: topHub.city, state: topHub.state, count: topHub.count } : null,
    season: seasonValues.length === 1 ? seasonValues[0] : 'Mixed',
    sportType: combinedActive ? 'Combined Olympic + Paralympic' : (typeValues.length === 1 ? typeValues[0] : 'Mixed'),
  };
}

export function topStatesForSport(sport, { program = null, season = null, limit = 10, combinePara = false } = {}) {
  if (!sport) return [];
  const sportNames = new Set(getSportPair(sport, combinePara));

  // Distinct athletes per state from participation (avoids the variant double-count
  // bug if the same athlete competes under both Olympic + Para names of a sport).
  const athletesByState = new Map();
  const partByState = new Map();
  for (const r of getStore().participation) {
    if (!sportNames.has(r.sport)) continue;
    if (!matchProgram(r, program) || !matchSeason(r, season)) continue;
    if (!r.hometown_state) continue;
    let bag = athletesByState.get(r.hometown_state);
    if (!bag) { bag = new Set(); athletesByState.set(r.hometown_state, bag); }
    bag.add(r.athlete_id);
    partByState.set(r.hometown_state, (partByState.get(r.hometown_state) || 0) + 1);
  }

  return Array.from(athletesByState.entries())
    .map(([state, ids]) => ({
      state,
      name: STATE_NAMES[state] || state,
      athletes: ids.size,
      athleteCount: ids.size,
      participation: partByState.get(state) || 0,
    }))
    .sort((a, b) => b.athletes - a.athletes)
    .slice(0, limit);
}

export function topHometownsForSport(sport, { program = null, season = null, limit = 10, combinePara = false } = {}) {
  if (!sport) return [];
  const sportNames = new Set(getSportPair(sport, combinePara));
  const rows = getStore().participation.filter(
    (r) => sportNames.has(r.sport) && matchProgram(r, program) && matchSeason(r, season)
  );
  // Distinct athletes per hub (a single hometown could send the same person to
  // multiple events of the same sport).
  const ids = new Map();
  const meta = new Map();
  for (const r of rows) {
    if (!r.hometown_key) continue;
    let bag = ids.get(r.hometown_key);
    if (!bag) { bag = new Set(); ids.set(r.hometown_key, bag); }
    bag.add(r.athlete_id);
    if (!meta.has(r.hometown_key)) meta.set(r.hometown_key, { city: r.hometown_city, state: r.hometown_state });
  }
  return Array.from(ids.entries())
    .map(([key, set]) => ({ key, ...meta.get(key), athletes: set.size, athleteCount: set.size }))
    .filter((r) => r.city && r.state)
    .sort((a, b) => b.athletes - a.athletes)
    .slice(0, limit);
}

/**
 * Footprint snapshot for a sport: how broadly it's distributed across states
 * and hubs, plus its program (Olympic/Paralympic) and season character.
 *
 * Concentration `type` is bucketed by the share of athletes in the top 3
 * states:
 *   < 0.30                  -> 'Nationally distributed'
 *   >= 0.30 and < 0.55      -> 'Regionally clustered'
 *   >= 0.55                 -> 'Highly concentrated'
 *
 * Returns null if the sport has no matching rows after applying filters.
 */
export function getSportFootprint(sport, { program = null, season = null, combinePara = false } = {}) {
  if (!sport) return null;

  const summary = getSportSummary(sport, { program, season, combinePara });
  if (!summary) return null;

  const sportNames = new Set(getSportPair(sport, combinePara));
  const sportRows = getStore().stateSportSummary.filter(
    (r) => sportNames.has(r.sport) && matchProgram(r, program) && matchSeason(r, season)
  );

  const topStates = topStatesForSport(sport, { program, season, combinePara, limit: 10 });
  const totalAthletes = summary.totalAthletes;
  const top1 = topStates[0] ? topStates[0].athletes : 0;
  const top3 = topStates.slice(0, 3).reduce((acc, r) => acc + r.athletes, 0);
  const top1Share = totalAthletes > 0 ? top1 / totalAthletes : 0;
  const top3Share = totalAthletes > 0 ? top3 / totalAthletes : 0;

  let type;
  if (top3Share < 0.30) type = 'Nationally distributed';
  else if (top3Share < 0.55) type = 'Regionally clustered';
  else type = 'Highly concentrated';

  const types = new Set(sportRows.map((r) => r.sport_type));
  let programRelationship;
  if (types.size > 1) programRelationship = 'Both Olympic and Paralympic variants';
  else if (types.has('Olympic')) programRelationship = 'Olympic only';
  else if (types.has('Paralympic')) programRelationship = 'Paralympic only';
  else programRelationship = 'Both Olympic and Paralympic variants';

  return {
    sport,
    totalAthletes,
    statesRepresented: summary.statesRepresented,
    hubsRepresented: summary.hubsRepresented,
    topState: summary.topState
      ? { state: summary.topState.state, name: summary.topState.name, athletes: summary.topState.athletes }
      : null,
    top1Share,
    top3Share,
    type,
    programRelationship,
    season: summary.season,
  };
}

/**
 * Lightweight footprint classification using the same Top-3-states share
 * bucketing as `getSportFootprint`, but with Title Case labels that suit a
 * prominent chip. Returns the canonical type plus the top-3 share and the
 * top-3 state breakdown used to derive it.
 *
 *   < 0.30                  -> 'Nationally Distributed'
 *   >= 0.30 and < 0.55      -> 'Regionally Clustered'
 *   >= 0.55                 -> 'Highly Concentrated'
 */
export function getSportFootprintType(sport, { program = null, season = null, combinePara = false } = {}) {
  if (!sport) return null;
  const summary = getSportSummary(sport, { program, season, combinePara });
  if (!summary || !summary.totalAthletes) return null;
  const topStates = topStatesForSport(sport, { program, season, combinePara, limit: 3 });
  const top3Athletes = topStates.reduce((acc, r) => acc + r.athletes, 0);
  const topThreeShare = summary.totalAthletes > 0 ? top3Athletes / summary.totalAthletes : 0;
  let type;
  if (topThreeShare < 0.30) type = 'Nationally Distributed';
  else if (topThreeShare < 0.55) type = 'Regionally Clustered';
  else type = 'Highly Concentrated';
  return {
    type,
    topThreeShare,
    topStates: topStates.map((r) => ({ state: r.state, athletes: r.athletes })),
  };
}

/**
 * State-spread summary for the State Spread module on the Sport Explorer.
 * Reuses `getSportSummary` (distinct-athlete totals) and `topStatesForSport`.
 */
export function getSportStateSpread(sport, { program = null, season = null, combinePara = false } = {}) {
  if (!sport) return null;
  const summary = getSportSummary(sport, { program, season, combinePara });
  if (!summary) return null;
  const top = topStatesForSport(sport, { program, season, combinePara, limit: 1 })[0] || null;
  const topStateShare = summary.totalAthletes && top ? top.athletes / summary.totalAthletes : 0;
  return {
    stateCount: summary.statesRepresented,
    hubCount: summary.hubsRepresented,
    totalAthletes: summary.totalAthletes,
    topStateShare,
    topState: top ? { state: top.state, name: top.name, athletes: top.athletes } : null,
  };
}

/**
 * Top hometown hubs for a single sport, including the Olympic / Paralympic
 * split per hub and the hub's share of the sport's distinct athlete total.
 * Distinct athletes per hub (a single hometown could send the same person to
 * multiple events of the same sport).
 */
export function getTopHometownHubsForSport(sport, { program = null, season = null, limit = 10, combinePara = false } = {}) {
  if (!sport) return [];
  const sportNames = new Set(getSportPair(sport, combinePara));
  const rows = getStore().participation.filter(
    (r) => sportNames.has(r.sport) && matchProgram(r, program) && matchSeason(r, season)
  );
  const allIds = new Map();
  const olyIds = new Map();
  const paraIds = new Map();
  const meta = new Map();
  const sportAthletes = new Set();
  for (const r of rows) {
    sportAthletes.add(r.athlete_id);
    if (!r.hometown_key) continue;
    if (!allIds.has(r.hometown_key)) allIds.set(r.hometown_key, new Set());
    allIds.get(r.hometown_key).add(r.athlete_id);
    if (r.sport_type === 'Olympic') {
      if (!olyIds.has(r.hometown_key)) olyIds.set(r.hometown_key, new Set());
      olyIds.get(r.hometown_key).add(r.athlete_id);
    } else if (r.sport_type === 'Paralympic') {
      if (!paraIds.has(r.hometown_key)) paraIds.set(r.hometown_key, new Set());
      paraIds.get(r.hometown_key).add(r.athlete_id);
    }
    if (!meta.has(r.hometown_key)) meta.set(r.hometown_key, { city: r.hometown_city, state: r.hometown_state });
  }
  const sportTotal = sportAthletes.size;
  return Array.from(allIds.entries())
    .map(([key, set]) => ({
      key,
      ...meta.get(key),
      athletes: set.size,
      athleteCount: set.size,
      olympic: (olyIds.get(key) || new Set()).size,
      paralympic: (paraIds.get(key) || new Set()).size,
      share: sportTotal ? set.size / sportTotal : 0,
    }))
    .filter((r) => r.city && r.state)
    .sort((a, b) => b.athletes - a.athletes)
    .slice(0, limit);
}

const _relatedCache = new Map();

/**
 * Top `n` sports whose top-10 home-state set most overlaps with `sport`'s
 * top-10 home-state set, ranked by Jaccard similarity. Excludes the input
 * sport, sports with no states, and zero-similarity matches. Memoized per
 * `sport+n` for the session.
 */
export function getRelatedSportsByGeography(sport, n = 5) {
  if (!sport) return [];
  const cacheKey = `${sport}::${n}`;
  if (_relatedCache.has(cacheKey)) return _relatedCache.get(cacheKey);

  const baseStates = new Set(topStatesForSport(sport, { limit: 10 }).map((r) => r.state));
  if (baseStates.size === 0) {
    _relatedCache.set(cacheKey, []);
    return [];
  }

  const results = [];
  for (const other of getAllSports()) {
    if (other === sport) continue;
    const otherStates = new Set(topStatesForSport(other, { limit: 10 }).map((r) => r.state));
    if (otherStates.size === 0) continue;
    let inter = 0;
    for (const s of otherStates) if (baseStates.has(s)) inter += 1;
    if (inter === 0) continue;
    const union = baseStates.size + otherStates.size - inter;
    const similarity = inter / union;
    results.push({ sport: other, similarity, sharedStates: inter });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  const out = results.slice(0, n);
  _relatedCache.set(cacheKey, out);
  return out;
}
