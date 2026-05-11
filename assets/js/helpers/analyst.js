/**
 * helpers/analyst.js — local deterministic answer registry for Ask the Analyst
 *
 * Each handler returns:
 *   { headline, bullets:[string], table?:{ columns, rows }, evidence:[Evidence], related:[chipId] }
 *
 * Pages should NOT format these into HTML themselves — they just render what
 * the handler returns. This keeps the "what data is used" surface honest and
 * reproducible for the future Gemini-powered Ask experience.
 *
 * Evidence records are produced exclusively via `buildEvidence(...)` so the
 * shape stays consistent across Ask the Analyst, Methodology, and future
 * Gemini-routed responses. Each record carries: { files, fields, rowCount, notes }.
 *
 * Guardrails (DISALLOWED_TOPICS / UNSAFE_WORDS / SAFE_LANGUAGE / RESPONSE_RULES
 * / REPHRASE_RULES) live in `./guardrails.js`. The intent taxonomy lives in
 * `./intent.js`. This file only owns the chip registry + per-chip handlers.
 */

import { getStore, STATE_NAMES } from '../data/store.js';
import {
  getTopHometowns, getSportDiversityRankings,
  getStateAggregateMap, getScopedNationalTotals,
} from './aggregates.js';
import { getAllSports, getSportFootprint } from './sports.js';
import { getParityLensData } from './parity.js';
import { compareStates } from './compare.js';
import { buildEvidence } from './evidenceModel.js';
import { applyRephraseRules } from './guardrails.js';
import { INTENTS } from './intent.js';

function fmtPct(r, d = 1) { return r == null ? '—' : `${(r * 100).toFixed(d)}%`; }
function fmtInt(n)        { return n == null ? '—' : Number(n).toLocaleString(); }

function evidenceStateSummary(fields, note, rowCount = getStore().stateSummary.length) {
  return buildEvidence({ files: ['state_summary.json'], fields, rowCount, notes: note ? [note] : [] });
}
function evidenceParticipation(fields, note, rowCount = getStore().participation.length) {
  return buildEvidence({ files: ['athlete_participation_clean.json'], fields, rowCount, notes: note ? [note] : [] });
}
function evidenceHometownSummary(fields, note, rowCount = getStore().hometownSummary.length) {
  return buildEvidence({ files: ['hometown_summary.json'], fields, rowCount, notes: note ? [note] : [] });
}
function evidenceStateSport(fields, note, rowCount = getStore().stateSportSummary.length) {
  return buildEvidence({ files: ['state_sport_summary.json'], fields, rowCount, notes: note ? [note] : [] });
}
function evidenceClimate(fields, note, rowCount = getStore().climate.length) {
  return buildEvidence({ files: ['climate_state_summary.json'], fields, rowCount, notes: note ? [note] : [] });
}

// Distinct participation rows under a filter combo (used for honest rowCount
// reporting on filtered Ask handlers). Mirrors matchFilters semantics.
function countParticipationWhere(predicate) {
  let n = 0;
  for (const r of getStore().participation) if (predicate(r)) n += 1;
  return n;
}

const HANDLERS = {
  'top-states-athletes': () => {
    const aggMap = getStateAggregateMap({});
    const nat = getScopedNationalTotals({}).total;
    const top = Array.from(aggMap.values())
      .filter((a) => a.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map((a) => ({ ...a, name: STATE_NAMES[a.state] || a.state }));
    return {
      headline: 'States with the highest athlete counts',
      bullets: [
        `${top[0].name} leads with ${fmtInt(top[0].total)} total athletes — about ${fmtPct(top[0].total / nat)} of the national roster.`,
        `${top[1].name} (${fmtInt(top[1].total)}) and ${top[2].name} (${fmtInt(top[2].total)}) round out the top three.`,
        `The ten leading states together account for ${fmtPct(top.reduce((s, r) => s + r.total, 0) / nat)} of all athletes.`,
      ],
      table: {
        columns: ['Rank', 'State', 'Athletes'],
        rows: top.map((r, i) => [i + 1, r.name, fmtInt(r.total)]),
      },
      evidence: [evidenceParticipation(['hometown_state', 'athlete_id'], 'Distinct athletes per state.')],
      related: ['top-states-diversity', 'top-states-paralympic', 'high-counts-and-diversity'],
    };
  },

  'top-states-diversity': () => {
    const top = getSportDiversityRankings(10);
    return {
      headline: 'States with the broadest sport diversity',
      bullets: [
        `${top[0].name} is represented across ${top[0].sport_count} distinct sports.`,
        `${top[1].name} (${top[1].sport_count}) and ${top[2].name} (${top[2].sport_count}) follow — diversity tracks athlete count loosely but isn't identical.`,
      ],
      table: {
        columns: ['Rank', 'State', 'Sports', 'Athletes'],
        rows: top.map((r, i) => [i + 1, r.name, r.sport_count, fmtInt(r.total_athletes)]),
      },
      evidence: [evidenceStateSummary(['state', 'sport_count', 'total_athletes'])],
      related: ['top-states-athletes', 'high-counts-and-diversity'],
    };
  },

  'top-states-paralympic': () => {
    const aggMap = getStateAggregateMap({});
    const top = Array.from(aggMap.values())
      .filter((a) => a.paralympic > 0)
      .sort((a, b) => b.paralympic - a.paralympic)
      .slice(0, 10)
      .map((a) => ({ ...a, name: STATE_NAMES[a.state] || a.state }));
    return {
      headline: 'States with the most Paralympic athletes',
      bullets: [
        `${top[0].name} fields the most Paralympic athletes (${fmtInt(top[0].paralympic)}).`,
        `${top[1].name} (${fmtInt(top[1].paralympic)}) and ${top[2].name} (${fmtInt(top[2].paralympic)}) follow.`,
      ],
      table: {
        columns: ['Rank', 'State', 'Paralympic', 'Total', 'Para share'],
        rows: top.map((r, i) => [i + 1, r.name, fmtInt(r.paralympic), fmtInt(r.total), fmtPct(r.paralympicShare)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_state', 'sport_type', 'athlete_id'],
        'Distinct athletes per state with sport_type = "Paralympic".',
        countParticipationWhere((r) => r.sport_type === 'Paralympic' && r.hometown_state),
      )],
      related: ['most-balanced-parity', 'top-states-athletes'],
    };
  },

  'most-balanced-parity': () => {
    const lens = getParityLensData();
    const top = lens.balancedRanking.slice(0, 10);
    return {
      headline: 'States with the most balanced Olympic / Paralympic representation',
      bullets: [
        `Among states with at least ${lens.minAthletes} total athletes, ${top[0].name} has the highest Paralympic share at ${fmtPct(top[0].paralympic_share)}.`,
        `${top[1].name} (${fmtPct(top[1].paralympic_share)}) and ${top[2].name} (${fmtPct(top[2].paralympic_share)}) follow.`,
        `States below the ${lens.minAthletes}-athlete floor are excluded so a single Paralympic athlete can't dominate the ranking.`,
      ],
      table: {
        columns: ['Rank', 'State', 'Para share', 'Paralympic', 'Total'],
        rows: top.map((r, i) => [i + 1, r.name, fmtPct(r.paralympic_share), fmtInt(r.paralympic), fmtInt(r.total)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_state', 'sport_type', 'athlete_id'],
        `Distinct athletes per state. Excludes states with total < ${lens.minAthletes}.`,
        countParticipationWhere((r) => !!r.hometown_state),
      )],
      related: ['top-states-paralympic'],
    };
  },

  'top-hometown-hubs': () => {
    const top = getTopHometowns(10);
    return {
      headline: 'Most common hometown hubs nationally',
      bullets: [
        `${top[0].hometown_city}, ${top[0].hometown_state} is the most-represented hometown (${fmtInt(top[0].total_athletes)} athletes).`,
        `${top[1].hometown_city}, ${top[1].hometown_state} (${fmtInt(top[1].total_athletes)}) and ${top[2].hometown_city}, ${top[2].hometown_state} (${fmtInt(top[2].total_athletes)}) round out the top three.`,
      ],
      table: {
        columns: ['Rank', 'Hometown', 'Athletes', 'Sports'],
        rows: top.map((r, i) => [i + 1, `${r.hometown_city}, ${r.hometown_state}`, fmtInt(r.total_athletes), r.sport_count]),
      },
      evidence: [evidenceHometownSummary(['hometown_city', 'hometown_state', 'total_athletes', 'sport_count'])],
      related: ['top-hometown-hubs-winter', 'top-states-athletes'],
    };
  },

  'top-hometown-hubs-winter': () => {
    const tally = new Map();
    for (const r of getStore().participation) {
      if (r.season !== 'Winter' || !r.hometown_key) continue;
      const cur = tally.get(r.hometown_key) || { city: r.hometown_city, state: r.hometown_state, athletes: new Set() };
      cur.athletes.add(r.athlete_id);
      tally.set(r.hometown_key, cur);
    }
    const top = Array.from(tally.values())
      .map((t) => ({ ...t, count: t.athletes.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return {
      headline: 'Hometown hubs for winter sports',
      bullets: [
        `${top[0].city}, ${top[0].state} sends the most athletes to winter sports (${fmtInt(top[0].count)}).`,
        `${top[1].city}, ${top[1].state} (${fmtInt(top[1].count)}) and ${top[2].city}, ${top[2].state} (${fmtInt(top[2].count)}) follow.`,
      ],
      table: {
        columns: ['Rank', 'Hometown', 'Winter athletes'],
        rows: top.map((r, i) => [i + 1, `${r.city}, ${r.state}`, fmtInt(r.count)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_city', 'hometown_state', 'season', 'athlete_id'],
        'Filtered to season = "Winter".',
        countParticipationWhere((r) => r.season === 'Winter' && r.hometown_key),
      )],
      related: ['top-hometown-hubs', 'high-winter-share'],
    };
  },

  'sports-broadest-state-coverage': () => {
    const map = new Map();
    for (const r of getStore().stateSportSummary) {
      const cur = map.get(r.sport) || { sport: r.sport, season: r.season, sportType: r.sport_type, states: new Set(), athletes: 0 };
      cur.states.add(r.state);
      cur.athletes += r.athlete_count;
      map.set(r.sport, cur);
    }
    const top = Array.from(map.values())
      .map((r) => ({ sport: r.sport, season: r.season, sportType: r.sportType, states: r.states.size, athletes: r.athletes }))
      .sort((a, b) => b.states - a.states)
      .slice(0, 10);
    return {
      headline: 'Sports represented across the most states',
      bullets: [
        `${top[0].sport} appears in ${top[0].states} states (${fmtInt(top[0].athletes)} athletes).`,
        `${top[1].sport} (${top[1].states} states) and ${top[2].sport} (${top[2].states} states) follow.`,
      ],
      table: {
        columns: ['Rank', 'Sport', 'States', 'Athletes', 'Type'],
        rows: top.map((r, i) => [i + 1, r.sport, r.states, fmtInt(r.athletes), r.sportType]),
      },
      evidence: [evidenceStateSport(['sport', 'state', 'athlete_count', 'sport_type'])],
      related: ['top-states-athletes', 'top-states-diversity'],
    };
  },

  'compare-ca-co': () => {
    const cmp = compareStates('CA', 'CO');
    return {
      headline: 'California vs Colorado',
      bullets: cmp.summaryBullets,
      table: {
        columns: ['Metric', 'California', 'Colorado'],
        rows: [
          ['Total athletes',       fmtInt(cmp.kpis.a.total_athletes), fmtInt(cmp.kpis.b.total_athletes)],
          ['Olympic athletes',     fmtInt(cmp.kpis.a.olympic_athletes), fmtInt(cmp.kpis.b.olympic_athletes)],
          ['Paralympic athletes',  fmtInt(cmp.kpis.a.paralympic_athletes), fmtInt(cmp.kpis.b.paralympic_athletes)],
          ['Summer athletes',      fmtInt(cmp.kpis.a.summer_athletes), fmtInt(cmp.kpis.b.summer_athletes)],
          ['Winter athletes',      fmtInt(cmp.kpis.a.winter_athletes), fmtInt(cmp.kpis.b.winter_athletes)],
          ['Sport diversity',      cmp.kpis.a.sport_count, cmp.kpis.b.sport_count],
          ['Paralympic share',     fmtPct(cmp.kpis.a.paralympic_share), fmtPct(cmp.kpis.b.paralympic_share)],
          ['Share of national',    fmtPct(cmp.kpis.a.share), fmtPct(cmp.kpis.b.share)],
          ['Avg annual temp °F',   cmp.climate.a?.avg_annual_temp_f ?? '—', cmp.climate.b?.avg_annual_temp_f ?? '—'],
          ['Avg annual precip in', cmp.climate.a?.avg_annual_precip_in ?? '—', cmp.climate.b?.avg_annual_precip_in ?? '—'],
        ],
      },
      evidence: [
        evidenceStateSummary(['total_athletes','olympic_athletes','paralympic_athletes','summer_athletes','winter_athletes','sport_count']),
        evidenceClimate(['avg_annual_temp_f','avg_annual_precip_in']),
      ],
      related: ['top-states-athletes', 'most-balanced-parity'],
    };
  },

  'high-counts-and-diversity': () => {
    const total = getScopedNationalTotals({}).total;
    const aggMap = getStateAggregateMap({});
    const all = Array.from(aggMap.values()).filter((a) => a.total > 0);
    // Composite: rank by (total_athletes_rank + sport_count_rank), pick top
    const byTotal = new Map(all.slice().sort((a, b) => b.total      - a.total     ).map((r, i) => [r.state, i]));
    const byDiv   = new Map(all.slice().sort((a, b) => b.sportCount - a.sportCount).map((r, i) => [r.state, i]));
    const ranked  = all
      .map((r) => ({ ...r, name: STATE_NAMES[r.state] || r.state, score: (byTotal.get(r.state) + byDiv.get(r.state)) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 10);
    return {
      headline: 'States combining high athlete counts with broad sport diversity',
      bullets: [
        `${ranked[0].name} ranks near the top on both volume (${fmtInt(ranked[0].total)} athletes) and breadth (${ranked[0].sportCount} sports).`,
        `${ranked[1].name} and ${ranked[2].name} also pair scale with breadth.`,
      ],
      table: {
        columns: ['Rank', 'State', 'Athletes', 'Sports', 'Share'],
        rows: ranked.map((r, i) => [i + 1, r.name, fmtInt(r.total), r.sportCount, fmtPct(r.total / total)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_state', 'sport', 'athlete_id'],
        'Composite ranking: average of total-athletes rank and distinct-sports rank.',
        countParticipationWhere((r) => !!r.hometown_state),
      )],
      related: ['top-states-athletes', 'top-states-diversity'],
    };
  },

  'high-winter-share': () => {
    const aggMap = getStateAggregateMap({});
    const ranked = Array.from(aggMap.values())
      .filter((r) => r.total >= 30)
      .map((r) => ({ state: r.state, name: STATE_NAMES[r.state] || r.state, total: r.total, winter: r.winter, share: r.total ? r.winter / r.total : 0 }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 10);
    return {
      headline: 'States with the highest winter-sports share',
      bullets: [
        `${ranked[0].name} has the highest winter share at ${fmtPct(ranked[0].share)} (${fmtInt(ranked[0].winter)} of ${fmtInt(ranked[0].total)}).`,
        `${ranked[1].name} (${fmtPct(ranked[1].share)}) and ${ranked[2].name} (${fmtPct(ranked[2].share)}) follow.`,
        'States with fewer than 30 total athletes are excluded so individual athletes don\'t dominate the share.',
      ],
      table: {
        columns: ['Rank', 'State', 'Winter share', 'Winter', 'Total'],
        rows: ranked.map((r, i) => [i + 1, r.name, fmtPct(r.share), fmtInt(r.winter), fmtInt(r.total)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_state', 'season', 'athlete_id'],
        'Distinct athletes per state. Excludes states with total < 30.',
        countParticipationWhere((r) => !!r.hometown_state),
      )],
      related: ['top-hometown-hubs-winter', 'top-states-athletes'],
    };
  },

  'top-hubs-broadest-sport': () => {
    const top = getStore().hometownSummary
      .slice()
      .sort((a, b) => b.sport_count - a.sport_count)
      .slice(0, 10);
    return {
      headline: 'Hometown hubs with the broadest sport diversity',
      bullets: [
        `${top[0].hometown_city}, ${top[0].hometown_state} appears across ${top[0].sport_count} distinct sports (${fmtInt(top[0].total_athletes)} athletes).`,
        `${top[1].hometown_city}, ${top[1].hometown_state} (${top[1].sport_count}) and ${top[2].hometown_city}, ${top[2].hometown_state} (${top[2].sport_count}) follow.`,
        'These hubs combine athletes across multiple disciplines, which could suggest a broad composition rather than a single-sport footprint.',
      ],
      table: {
        columns: ['Rank', 'Hometown', 'Sports', 'Athletes'],
        rows: top.map((r, i) => [i + 1, `${r.hometown_city}, ${r.hometown_state}`, r.sport_count, fmtInt(r.total_athletes)]),
      },
      evidence: [evidenceHometownSummary(['hometown_city', 'hometown_state', 'sport_count', 'total_athletes'])],
      related: ['top-hometown-hubs', 'top-states-diversity'],
    };
  },

  'sports-most-concentrated': () => {
    const sports = getAllSports();
    const rows = [];
    for (const sport of sports) {
      const fp = getSportFootprint(sport);
      if (!fp) continue;
      rows.push({
        sport,
        top3Share: fp.top3Share,
        type: fp.type,
        states: fp.statesRepresented,
        athletes: fp.totalAthletes,
      });
    }
    const top = rows.sort((a, b) => b.top3Share - a.top3Share).slice(0, 10);
    return {
      headline: 'Sports with the most geographically concentrated footprint',
      bullets: [
        `${top[0].sport} concentrates ${fmtPct(top[0].top3Share)} of its athletes in just three states (${top[0].type}).`,
        `${top[1].sport} (${fmtPct(top[1].top3Share)}) and ${top[2].sport} (${fmtPct(top[2].top3Share)}) follow.`,
        'Concentration describes roster geography in this data, not access or success.',
      ],
      table: {
        columns: ['Rank', 'Sport', 'Top-3 share', 'Footprint type', 'States'],
        rows: top.map((r, i) => [i + 1, r.sport, fmtPct(r.top3Share), r.type, r.states]),
      },
      evidence: [evidenceStateSport(['sport', 'state', 'athlete_count'])],
      related: ['sports-broadest-state-coverage', 'top-states-athletes'],
    };
  },

  'most-mixed-season': () => {
    const aggMap = getStateAggregateMap({});
    const ranked = Array.from(aggMap.values())
      .filter((r) => r.total >= 30)
      .map((r) => {
        const winterShare = r.total ? r.winter / r.total : 0;
        return {
          state: r.state,
          name: STATE_NAMES[r.state] || r.state,
          winterShare,
          winter: r.winter,
          total: r.total,
          score: 1 - Math.abs(winterShare - 0.5) * 2,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    return {
      headline: 'States with the most mixed Summer / Winter profile',
      bullets: [
        `${ranked[0].name} appears closest to a balanced split, with a winter share of ${fmtPct(ranked[0].winterShare)}.`,
        `${ranked[1].name} (${fmtPct(ranked[1].winterShare)}) and ${ranked[2].name} (${fmtPct(ranked[2].winterShare)}) follow.`,
        'States with fewer than 30 total athletes are excluded so small rosters don\'t dominate the mix.',
      ],
      table: {
        columns: ['Rank', 'State', 'Winter share', 'Winter', 'Total'],
        rows: ranked.map((r, i) => [i + 1, r.name, fmtPct(r.winterShare), fmtInt(r.winter), fmtInt(r.total)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_state', 'season', 'athlete_id'],
        'Distinct athletes per state. Excludes states with total < 30.',
        countParticipationWhere((r) => !!r.hometown_state),
      )],
      related: ['high-winter-share', 'top-states-athletes'],
    };
  },

  'top-hubs-both-program': () => {
    const lens = getParityLensData({ representation: 'both' });
    const top = lens.representationHubs.slice(0, 15);
    return {
      headline: 'Hometown hubs represented in both Olympic and Paralympic programs',
      bullets: [
        `${top[0].city}, ${top[0].state} appears in both programs with ${fmtInt(top[0].total)} athletes (${fmtInt(top[0].olympic)} Olympic, ${fmtInt(top[0].paralympic)} Paralympic).`,
        `${top[1].city}, ${top[1].state} (${fmtInt(top[1].total)}) and ${top[2].city}, ${top[2].state} (${fmtInt(top[2].total)}) follow.`,
        'These hubs send athletes to both Olympic and Paralympic programs in the data.',
      ],
      table: {
        columns: ['Rank', 'Hometown', 'Olympic', 'Paralympic', 'Total'],
        rows: top.map((r, i) => [i + 1, `${r.city}, ${r.state}`, fmtInt(r.olympic), fmtInt(r.paralympic), fmtInt(r.total)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_city', 'hometown_state', 'sport_type', 'athlete_id'],
        'Hubs with both Olympic and Paralympic athletes.',
        countParticipationWhere((r) => r.hometown_key && (r.sport_type === 'Olympic' || r.sport_type === 'Paralympic')),
      )],
      related: ['top-hometown-hubs', 'top-states-paralympic'],
    };
  },

  'states-without-climate': () => {
    const stateSet = new Set(getStore().stateSummary.map((r) => r.state));
    const climSet = new Set(getStore().climate.map((r) => r.state));
    const missing = Array.from(stateSet).filter((s) => !climSet.has(s)).sort();
    return {
      headline: 'States without NOAA climate data',
      bullets: [
        `${missing.length} states are excluded from climate joins: ${missing.map((s) => STATE_NAMES[s] || s).join(', ') || '—'}.`,
        'NOAA nClimDiv coverage excludes some non-contiguous areas (e.g. HI, AK) and territories.',
        'Climate normals are background context — any state missing here simply won\'t appear in climate-joined views.',
      ],
      table: {
        columns: ['State'],
        rows: missing.map((s) => [STATE_NAMES[s] || s]),
      },
      evidence: [
        evidenceClimate(['state']),
        evidenceStateSummary(['state']),
      ],
      related: ['top-states-athletes'],
    };
  },

  'high-counts-and-paralympic': () => {
    const aggMap = getStateAggregateMap({});
    const all = Array.from(aggMap.values()).filter((a) => a.total > 0 && a.paralympic > 0);
    const byTotal = new Map(all.slice().sort((a, b) => b.total      - a.total     ).map((r, i) => [r.state, i]));
    const byPara  = new Map(all.slice().sort((a, b) => b.paralympic - a.paralympic).map((r, i) => [r.state, i]));
    const ranked = all
      .map((r) => ({ ...r, name: STATE_NAMES[r.state] || r.state, score: byTotal.get(r.state) + byPara.get(r.state) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 10);
    return {
      headline: 'States pairing high athlete counts with strong Paralympic representation',
      bullets: [
        `${ranked[0].name} appears near the top on both volume (${fmtInt(ranked[0].total)} athletes) and Paralympic representation (${fmtInt(ranked[0].paralympic)}).`,
        `${ranked[1].name} and ${ranked[2].name} also combine scale with Paralympic presence.`,
        'This is a descriptive composite of two rankings, not a value judgment about programs.',
      ],
      table: {
        columns: ['Rank', 'State', 'Athletes', 'Paralympic', 'Para share'],
        rows: ranked.map((r, i) => [i + 1, r.name, fmtInt(r.total), fmtInt(r.paralympic), fmtPct(r.paralympicShare)]),
      },
      evidence: [evidenceParticipation(
        ['hometown_state', 'sport_type', 'athlete_id'],
        'Composite ranking: average of total-athletes rank and Paralympic-athletes rank.',
        countParticipationWhere((r) => !!r.hometown_state),
      )],
      related: ['top-states-paralympic', 'top-states-athletes'],
    };
  },

  'winter-share-and-cold-climate': () => {
    const aggMap = getStateAggregateMap({});
    const climateByState = new Map(getStore().climate.map((r) => [r.state, r]));
    const all = Array.from(aggMap.values())
      .filter((r) => r.total >= 30 && climateByState.has(r.state))
      .map((r) => {
        const c = climateByState.get(r.state);
        return {
          state: r.state,
          name: STATE_NAMES[r.state] || r.state,
          total: r.total,
          winter: r.winter,
          winterShare: r.total ? r.winter / r.total : 0,
          avgTemp: c.avg_annual_temp_f,
        };
      });
    const byShare = new Map(all.slice().sort((a, b) => b.winterShare - a.winterShare).map((r, i) => [r.state, i]));
    const byTemp  = new Map(all.slice().sort((a, b) => (a.avgTemp ?? Infinity) - (b.avgTemp ?? Infinity)).map((r, i) => [r.state, i]));
    const ranked = all
      .map((r) => ({ ...r, score: byShare.get(r.state) + byTemp.get(r.state) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 10);
    return {
      headline: 'High-winter-share states with colder climate normals',
      bullets: [
        `${ranked[0].name} pairs a winter share of ${fmtPct(ranked[0].winterShare)} with an average annual temperature of ${ranked[0].avgTemp ?? '—'}°F.`,
        `${ranked[1].name} (${fmtPct(ranked[1].winterShare)}, ${ranked[1].avgTemp ?? '—'}°F) and ${ranked[2].name} (${fmtPct(ranked[2].winterShare)}, ${ranked[2].avgTemp ?? '—'}°F) follow.`,
        'Climate normals are background context — not used to explain or predict participation.',
      ],
      table: {
        columns: ['Rank', 'State', 'Winter share', 'Avg temp °F', 'Total'],
        rows: ranked.map((r, i) => [i + 1, r.name, fmtPct(r.winterShare), r.avgTemp ?? '—', fmtInt(r.total)]),
      },
      evidence: [
        evidenceParticipation(
          ['hometown_state', 'season', 'athlete_id'],
          'Excludes states with total < 30 or missing NOAA climate data.',
          countParticipationWhere((r) => !!r.hometown_state),
        ),
        evidenceClimate(['state', 'avg_annual_temp_f']),
      ],
      related: ['high-winter-share', 'top-hometown-hubs-winter'],
    };
  },
};

export const SUGGESTED_QUESTIONS = [
  { id: 'top-states-athletes',           intent: INTENTS.TOP_STATES,          category: 'Geography',        label: 'Which states have the highest athlete counts?' },
  { id: 'top-states-diversity',          intent: INTENTS.SPORT_DIVERSITY,     category: 'Geography',        label: 'Which states have the broadest sport diversity?' },
  { id: 'top-states-paralympic',         intent: INTENTS.PARITY_STATES,       category: 'Parity',           label: 'Which states have the most Paralympic athletes?' },
  { id: 'most-balanced-parity',          intent: INTENTS.PARITY_STATES,       category: 'Parity',           label: 'Which states have the most balanced parity?' },
  { id: 'top-hometown-hubs',             intent: INTENTS.TOP_HOMETOWN_HUBS,   category: 'Geography',        label: 'Which hometown hubs appear most often?' },
  { id: 'top-hometown-hubs-winter',      intent: INTENTS.TOP_HOMETOWN_HUBS,   category: 'Geography',        label: 'Which hometown hubs appear most often for winter sports?', hidden: true },
  { id: 'sports-broadest-state-coverage',intent: INTENTS.SPORT_FOOTPRINT,     category: 'Sports',           label: 'Which sports appear across the most states?' },
  { id: 'compare-ca-co',                 intent: INTENTS.COMPARE_STATES,      category: 'Compare',          label: 'Compare California and Colorado.' },
  { id: 'high-counts-and-diversity',     intent: INTENTS.SPORT_DIVERSITY,     category: 'Geography',        label: 'Which states combine high athlete counts with broad sport diversity?', hidden: true },
  { id: 'high-winter-share',             intent: INTENTS.WINTER_SHARE,        category: 'Geography',        label: 'Which states have high winter athlete share?' },
  { id: 'top-hubs-broadest-sport',       intent: INTENTS.TOP_HOMETOWN_HUBS,   category: 'Geography',        label: 'Which hometown hubs have the broadest sport diversity?', hidden: true },
  { id: 'sports-most-concentrated',      intent: INTENTS.SPORT_CONCENTRATION, category: 'Sports',           label: 'Which sports are most geographically concentrated?' },
  { id: 'most-mixed-season',             intent: INTENTS.WINTER_SHARE,        category: 'Geography',        label: 'Which states have the most mixed Summer/Winter profile?', hidden: true },
  { id: 'top-hubs-both-program',         intent: INTENTS.PARITY_HUBS,         category: 'Parity',           label: 'Which hometown hubs host both programs?' },
  { id: 'states-without-climate',        intent: INTENTS.CLIMATE_CONTEXT,     category: 'Climate Context',  label: 'Which states have no NOAA climate data?', hidden: true },
  { id: 'high-counts-and-paralympic',    intent: INTENTS.PARITY_STATES,       category: 'Parity',           label: 'Which states combine high athlete counts with strong Paralympic representation?', hidden: true },
  { id: 'winter-share-and-cold-climate', intent: INTENTS.CLIMATE_CONTEXT,     category: 'Climate Context',  label: 'Which high-winter-share states have colder climate normals?' },
];

export function answerQuestion(id) {
  const handler = HANDLERS[id];
  if (!handler) return null;
  return { id, ...handler() };
}

/**
 * Back-compat shim around the centralized `applyRephraseRules` in
 * `./guardrails.js`. Keeps the `{ declineReason, safeQuestionId }` shape
 * Ask the Analyst already consumes.
 */
export function rephraseUnsafeQuestion(text) {
  const hit = applyRephraseRules(text);
  if (!hit) return null;
  return { declineReason: hit.declineReason, safeQuestionId: hit.safeQuestionId };
}
