/**
 * helpers/context.js
 *
 * Compact, JSON-serializable view summaries for the Gemini analyst layer.
 *
 * Each `get*Context()` function reads from the already-loaded store + existing
 * helpers and returns a small, capped object suitable for stamping onto a
 * Gemini prompt. No DOM access, no fetching, no side effects.
 */

import { getStore, STATE_NAMES } from '../data/store.js';
import {
  getScopedNationalTotals,
  getScopedStateTotals,
  getStateAggregateMap,
  getTopHometownsScoped,
} from './aggregates.js';
import { getStateClimate } from './states.js';
import { getTopSportsForState } from './topSports.js';
import { findSimilarStates } from './similar.js';
import {
  getSportFootprint,
  getSportSummary,
  topStatesForSport,
  topHometownsForSport,
} from './sports.js';
import { getParityLensData, getParalympicSportFootprint } from './parity.js';
import { compareStates } from './compare.js';

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

/**
 * @param {{ filters?: object, selectedState?: ?string }} [opts]
 */
export function getAtlasContext({ filters = {}, selectedState = null } = {}) {
  const f = filters || {};
  const safeFilters = {
    metric: f.metric || null,
    program: f.program || null,
    season: f.season || null,
    sport: f.sport || null,
  };

  // Current scoped view summary — derived from getStateAggregateMap so it
  // reflects active program/season/sport filters.
  const aggMap = getStateAggregateMap({
    program: safeFilters.program,
    season: safeFilters.season,
    sport: safeFilters.sport,
  });

  let visibleAthletes = 0;
  let statesRepresented = 0;
  let topState = null;
  for (const agg of aggMap.values()) {
    visibleAthletes += agg.total || 0;
    if ((agg.total || 0) > 0) statesRepresented += 1;
    if (!topState || (agg.total || 0) > topState.value) {
      topState = { state: agg.state, value: agg.total || 0 };
    }
  }
  if (topState && topState.value === 0) topState = null;

  const topHubsScoped = getTopHometownsScoped({
    program: safeFilters.program,
    season: safeFilters.season,
    sport: safeFilters.sport,
  }, 1);
  const topHub = topHubsScoped[0] || null;
  const topHometownHub = topHub
    ? { city: topHub.hometown_city, state: topHub.hometown_state, value: topHub.total_athletes }
    : null;

  const currentViewSummary = {
    visibleAthletes,
    statesRepresented,
    topState,
    topHometownHub,
  };

  // Selected state profile.
  let selectedStateProfile = null;
  let similarStates = [];
  let climateContext = null;

  if (selectedState) {
    // Honor active filters so the selected-state profile matches what's
    // visible everywhere else on the page. Top sports deliberately omits the
    // sport filter — narrowing to one sport would just return that single
    // sport. Top hubs honors all filters including sport.
    const scoped = getScopedStateTotals(selectedState, {
      program: safeFilters.program,
      season: safeFilters.season,
      sport: safeFilters.sport,
    });
    if (scoped && scoped.total > 0) {
      const topSports = getTopSportsForState(selectedState, {
        limit: 8,
        program: safeFilters.program,
        season: safeFilters.season,
      })
        .map((r) => ({ sport: r.sport, athletes: r.athletes }));
      const topHubs = getTopHometownsScoped({
        state: selectedState,
        program: safeFilters.program,
        season: safeFilters.season,
        sport: safeFilters.sport,
      }, 10)
        .map((r) => ({ city: r.hometown_city, state: r.hometown_state, athletes: r.total_athletes }));
      selectedStateProfile = {
        state: selectedState,
        totalAthletes: scoped.total,
        olympicAthletes: scoped.olympic,
        paralympicAthletes: scoped.paralympic,
        summerAthletes: scoped.summer,
        winterAthletes: scoped.winter,
        sportCount: scoped.sportCount,
        paralympicShare: scoped.paralympicShare,
        balanceIndex: scoped.balanceIndex,
        topSports,
        topHometownHubs: topHubs,
      };
    }
    similarStates = findSimilarStates(selectedState, { n: 5 }).map((s) => ({
      state: s.state,
      reason: s.closestLabel,
    }));
    const climate = getStateClimate(selectedState);
    if (climate) {
      climateContext = {
        avgAnnualTempF: climate.avg_annual_temp_f ?? null,
        avgAnnualPrecipIn: climate.avg_annual_precip_in ?? null,
      };
    }
  }

  return {
    view: 'atlas',
    selectedState: selectedState || null,
    filters: safeFilters,
    currentViewSummary,
    selectedStateProfile,
    similarStates: selectedState ? similarStates : [],
    climateContext,
  };
}

// ---------------------------------------------------------------------------
// Sport
// ---------------------------------------------------------------------------

function classifyFootprint(top3Share) {
  if (top3Share < 0.30) return 'Nationally Distributed';
  if (top3Share <= 0.55) return 'Regionally Clustered';
  return 'Highly Concentrated';
}

/**
 * @param {{ sport?: ?string, filters?: object }} [opts]
 */
export function getSportContext({ sport = null, filters = {} } = {}) {
  const f = filters || {};
  const safeFilters = {
    program: f.program || null,
    season: f.season || null,
    paraVariants: f.paraVariants || null,
  };
  const combinePara = safeFilters.paraVariants === 'combined';

  let footprint = null;
  let topStates = [];
  let topHometownHubs = [];

  if (sport) {
    const fp = getSportFootprint(sport, {
      program: safeFilters.program,
      season: safeFilters.season,
      combinePara,
    });
    const states = topStatesForSport(sport, {
      program: safeFilters.program,
      season: safeFilters.season,
      combinePara,
      limit: 10,
    });
    const hubs = topHometownsForSport(sport, {
      program: safeFilters.program,
      season: safeFilters.season,
      combinePara,
      limit: 10,
    });

    topStates = states.map((r) => ({ state: r.state, athletes: r.athletes }));
    topHometownHubs = hubs.map((r) => ({ city: r.city, state: r.state, athletes: r.athletes }));

    if (fp) {
      const summary = getSportSummary(sport, {
        program: safeFilters.program,
        season: safeFilters.season,
        combinePara,
      });
      const totalAthletes = fp.totalAthletes || 0;
      const topStateRow = fp.topState
        ? {
            state: fp.topState.state,
            athletes: fp.topState.athletes,
            share: totalAthletes ? fp.topState.athletes / totalAthletes : 0,
          }
        : null;
      const top3Share = fp.top3Share || 0;
      const olympicAthletes = summary?.olympic || 0;
      const paralympicAthletes = summary?.paralympic || 0;
      const paralympicShare = totalAthletes ? paralympicAthletes / totalAthletes : null;

      footprint = {
        totalAthletes,
        olympicAthletes,
        paralympicAthletes,
        statesRepresented: fp.statesRepresented || 0,
        hometownHubsRepresented: fp.hubsRepresented || 0,
        topState: topStateRow,
        topThreeStateShare: top3Share,
        footprintType: classifyFootprint(top3Share),
        paralympicShare,
        programComposition: {
          olympic: olympicAthletes,
          paralympic: paralympicAthletes,
        },
      };
    }
  }

  return {
    view: 'sport',
    selectedSport: sport || null,
    filters: safeFilters,
    footprint,
    topStates,
    topHometownHubs,
    allowedInterpretation: [
      'describe geographic spread',
      'describe concentration',
      'avoid causal claims',
      'avoid performance claims',
    ],
  };
}

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

/**
 * @param {{ filters?: object }} [opts]
 */
export function getParityContext({ filters = {} } = {}) {
  const f = filters || {};
  const safeFilters = {
    viewMode: f.viewMode || null,
    season: f.season || null,
    minAthletes: typeof f.minAthletes === 'number' ? f.minAthletes : null,
  };

  const parity = getParityLensData({
    season: safeFilters.season,
    minAthletes: safeFilters.minAthletes ?? undefined,
  });

  const equal = parity.equalFrame || { olympic: {}, paralympic: {} };
  const overlap = parity.overlapKpis || {};
  const paralympicSports = getParalympicSportFootprint({ season: safeFilters.season });

  const representationSummary = {
    olympic: {
      states: equal.olympic.states || 0,
      hubs: equal.olympic.hubs || 0,
      sports: equal.olympic.sports || 0,
    },
    paralympic: {
      states: equal.paralympic.states || 0,
      hubs: equal.paralympic.hubs || 0,
      sports: equal.paralympic.sports || 0,
    },
    overlap: {
      statesWithBoth: overlap.overlapStates || 0,
      hubsWithBoth: overlap.overlapHubs || 0,
      paralympicSports: paralympicSports.length,
    },
  };

  const topStatesByParalympicShare = (parity.balancedRanking || [])
    .slice(0, 10)
    .map((r) => ({
      state: r.state,
      totalAthletes: r.total,
      paralympicAthletes: r.paralympic,
      paralympicShare: r.paralympic_share,
      balanceIndex: r.balance_index,
    }));

  const topHubs = (parity.dualRepHubs || [])
    .slice(0, 10)
    .map((r) => ({
      city: r.city,
      state: r.state,
      olympicAthletes: r.olympic,
      paralympicAthletes: r.paralympic,
      totalAthletes: r.total,
    }));

  return {
    view: 'parity',
    filters: safeFilters,
    representationSummary,
    topStatesByParalympicShare,
    topHubs,
    interpretationRules: [
      'describe representation composition',
      'do not describe states as inclusive or supportive',
      'do not infer program quality',
    ],
  };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/**
 * @param {{ stateA?: ?string, stateB?: ?string }} [opts]
 */
export function getCompareContext({ stateA = null, stateB = null } = {}) {
  const base = {
    view: 'compare',
    stateA: stateA || null,
    stateB: stateB || null,
    comparisonSummary: null,
    stateProfiles: null,
    similarities: null,
    differences: null,
    interpretationRules: [
      'do not call one state better',
      'describe differences neutrally',
      'climate is context only',
    ],
  };

  if (!stateA || !stateB) return base;

  const cmp = compareStates(stateA, stateB);
  if (!cmp) return base;

  const a = cmp.kpis.a;
  const b = cmp.kpis.b;

  // mostDistinctContrast: rank metric gaps by NORMALIZED difference so a
  // 0–1 share isn't drowned out by raw athlete counts in the hundreds.
  // Counts use gap/mean (matches compare.js's mostDistinctContrast logic);
  // shares (already 0–1) use raw absolute gap.
  const normGap = (av, bv, kind) => {
    const gap = Math.abs(av - bv);
    if (kind === 'count') {
      const mean = (Math.abs(av) + Math.abs(bv)) / 2;
      return mean ? gap / mean : 0;
    }
    return gap;
  };
  const metricCandidates = [
    { metric: 'total_athletes',  av: a.total_athletes,            bv: b.total_athletes,            kind: 'count' },
    { metric: 'sport_count',     av: a.sport_count,               bv: b.sport_count,               kind: 'count' },
    { metric: 'paralympic_share',av: a.paralympic_share || 0,     bv: b.paralympic_share || 0,     kind: 'share' },
  ];
  metricCandidates.sort((x, y) => normGap(y.av, y.bv, y.kind) - normGap(x.av, x.bv, x.kind));
  const top = metricCandidates[0];
  const mostDistinctContrast = top
    ? {
        metric: top.metric,
        stateWithHigherValue: top.av >= top.bv ? stateA : stateB,
        difference: Math.abs(top.av - top.bv),
      }
    : null;

  const buildProfile = (kpi, climate, signature, hubs) => ({
    totalAthletes: kpi.total_athletes,
    sportCount: kpi.sport_count,
    winterShare: kpi.total_athletes ? (kpi.winter_athletes || 0) / kpi.total_athletes : 0,
    paralympicShare: kpi.paralympic_share || 0,
    balanceIndex: kpi.balance_index || 0,
    topSports: (signature || []).slice(0, 5).map((r) => ({ sport: r.sport, athletes: r.athletes })),
    topHubs: (hubs || []).slice(0, 5).map((r) => ({ city: r.city || r.hometown_city, athletes: r.athletes || r.total_athletes })),
    climate: climate
      ? {
          avgAnnualTempF: climate.avg_annual_temp_f ?? null,
          avgAnnualPrecipIn: climate.avg_annual_precip_in ?? null,
        }
      : null,
  });

  const profiles = {};
  profiles[stateA] = buildProfile(a, cmp.climate.a, cmp.signatureSports.a, cmp.hometownConcentration.a.topHubs);
  profiles[stateB] = buildProfile(b, cmp.climate.b, cmp.signatureSports.b, cmp.hometownConcentration.b.topHubs);

  return {
    view: 'compare',
    stateA,
    stateB,
    comparisonSummary: {
      atAGlance: (cmp.atAGlance || []).slice(),
      mostDistinctContrast,
    },
    stateProfiles: profiles,
    similarities: (cmp.similarities || []).slice(),
    differences: (cmp.differences || []).slice(),
    interpretationRules: base.interpretationRules,
  };
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

const INTENT_FACT_BUILDERS = {
  top_states:        buildTopStatesFacts,
  top_hometown_hubs: buildTopHubsFacts,
  sport_footprint:   buildSportFacts,
  sport_concentration: buildSportFacts,
  sport_diversity:   buildSportDiversityFacts,
  parity_states:     buildParityStatesFacts,
  parity_hubs:       buildParityHubsFacts,
  parity_sports:     buildParitySportsFacts,
  compare_states:    buildCompareStatesFacts,
  winter_share:      buildWinterShareFacts,
  climate_context:   buildWinterShareFacts,
  // Catch-all "answer anything" intent. Used when the classifier can't
  // pin the question to a narrower intent. The payload is broad but
  // capped (top-8s, not top-100s) so the prompt stays digestible.
  general:           buildGeneralAskFacts,
};

function nationalSummary() {
  const totals = getScopedNationalTotals({});
  return {
    totalAthletes: totals.total,
    olympicAthletes: totals.olympic,
    paralympicAthletes: totals.paralympic,
    summerAthletes: totals.summer,
    winterAthletes: totals.winter,
  };
}

function buildTopStatesFacts({ entities } = {}) {
  const map = getStateAggregateMap({});
  const all = Array.from(map.values())
    .filter((r) => (r.total || 0) > 0)
    .sort((a, b) => (b.total || 0) - (a.total || 0))
    .map((r) => ({
      state: r.state,
      name: STATE_NAMES[r.state] || r.state,
      totalAthletes: r.total || 0,
    }));
  const topStates = all.slice(0, 10);
  const bottomStates = all.slice(-10).reverse();
  return {
    facts: {
      national: nationalSummary(),
      direction: entities?.direction || null,
      topStates,
      bottomStates,
      totalStatesWithAthletes: all.length,
    },
    evidence: {
      files: ['state_summary.json'],
      fields: ['state', 'total_athletes'],
      rowCount: 52,
    },
  };
}

function buildTopHubsFacts({ entities } = {}) {
  const all = getTopHometownsScoped({}, 9999).map((h) => ({
    city: h.hometown_city,
    state: h.hometown_state,
    athletes: h.total_athletes,
  }));
  const topHubs = all.slice(0, 10);
  const bottomHubs = all.slice(-10).reverse();
  return {
    facts: {
      national: nationalSummary(),
      direction: entities?.direction || null,
      topHubs,
      bottomHubs,
      totalHubsWithAthletes: all.length,
    },
    evidence: {
      files: ['hometown_summary.json'],
      fields: ['hometown_city', 'hometown_state', 'total_athletes'],
      rowCount: all.length,
    },
  };
}

function buildSportFacts({ entities }) {
  const sport = entities?.sports?.[0] || null;
  if (!sport) return buildTopStatesFacts();
  const footprint = getSportFootprint(sport);
  const top = topStatesForSport(sport, 10).map((r) => ({
    state: r.state,
    name: STATE_NAMES[r.state] || r.state,
    athletes: r.total_athletes,
  }));
  return {
    facts: {
      sport,
      footprint: footprint && {
        totalAthletes: footprint.totalAthletes,
        statesRepresented: footprint.statesRepresented,
        topThreeStateShare: footprint.topThreeStateShare,
        footprintType: footprint.footprintType,
      },
      topStatesForSport: top,
    },
    evidence: {
      files: ['state_sport_summary.json', 'athlete_participation_clean.json'],
      fields: ['state', 'sport', 'total_athletes'],
      rowCount: top.length,
    },
  };
}

function buildSportDiversityFacts({ entities } = {}) {
  const map = getStateAggregateMap({});
  const all = Array.from(map.values())
    .filter((r) => (r.sportCount || 0) > 0)
    .sort((a, b) => (b.sportCount || 0) - (a.sportCount || 0))
    .map((r) => ({
      state: r.state,
      name: STATE_NAMES[r.state] || r.state,
      sportCount: r.sportCount || 0,
      totalAthletes: r.total || 0,
    }));
  return {
    facts: {
      direction: entities?.direction || null,
      topStatesByDiversity: all.slice(0, 10),
      bottomStatesByDiversity: all.slice(-10).reverse(),
    },
    evidence: {
      files: ['state_summary.json'],
      fields: ['state', 'sport_count', 'total_athletes'],
      rowCount: 52,
    },
  };
}

function buildParityStatesFacts({ entities } = {}) {
  const lens = getParityLensData({ minAthletes: 30 });
  const para = (lens?.paralympicRanking || []);
  const balanced = (lens?.balancedRanking || []);
  return {
    facts: {
      direction: entities?.direction || null,
      topByParalympicCount:
        para.slice(0, 10).map((r) => ({
          state: r.state,
          name: r.name,
          paralympicAthletes: r.paralympic_athletes,
          totalAthletes: r.total,
        })),
      bottomByParalympicCount:
        para.slice(-10).reverse().map((r) => ({
          state: r.state,
          name: r.name,
          paralympicAthletes: r.paralympic_athletes,
          totalAthletes: r.total,
        })),
      topByParalympicShare:
        balanced.slice(0, 10).map((r) => ({
          state: r.state,
          name: r.name,
          paralympicShare: r.paralympic_share,
          totalAthletes: r.total,
        })),
      bottomByParalympicShare:
        balanced.slice(-10).reverse().map((r) => ({
          state: r.state,
          name: r.name,
          paralympicShare: r.paralympic_share,
          totalAthletes: r.total,
        })),
      minAthletesFloor: 30,
    },
    evidence: {
      files: ['state_summary.json'],
      fields: ['state', 'paralympic_athletes', 'total_athletes'],
      rowCount: 52,
    },
  };
}

function buildParityHubsFacts() {
  const lens = getParityLensData({ minAthletes: 0 });
  const hubs = (lens?.dualRepHubs || []).slice(0, 10).map((h) => ({
    city: h.city,
    state: h.state,
    olympicAthletes: h.olympic,
    paralympicAthletes: h.paralympic,
    totalAthletes: h.total,
  }));
  return {
    facts: { topHubsBothPrograms: hubs },
    evidence: {
      files: ['hometown_summary.json'],
      fields: ['hometown_city', 'hometown_state', 'olympic_athletes', 'paralympic_athletes', 'total_athletes'],
      rowCount: hubs.length,
    },
  };
}

function buildParitySportsFacts() {
  const sports = (getParalympicSportFootprint() || []).slice(0, 10).map((s) => ({
    sport: s.sport,
    athletes: s.athletes,
    statesRepresented: s.states,
    hubsRepresented: s.hubs,
  }));
  return {
    facts: { paralympicSportFootprint: sports },
    evidence: {
      files: ['athlete_participation_clean.json'],
      fields: ['sport', 'state', 'athlete_id', 'sport_type'],
      rowCount: sports.length,
    },
  };
}

function buildCompareStatesFacts({ entities }) {
  const states = (entities?.states || []).slice(0, 2);
  if (states.length !== 2) return buildTopStatesFacts();
  const [a, b] = states;
  const cmp = compareStates(a, b);
  if (!cmp || !cmp.kpis) return buildTopStatesFacts();
  const slim = (k) => k && {
    totalAthletes: k.total_athletes,
    paralympicAthletes: k.paralympic_athletes,
    summerAthletes: k.summer_athletes,
    winterAthletes: k.winter_athletes,
    sportCount: k.sport_count,
    paralympicShare: k.paralympic_share,
  };
  return {
    facts: {
      stateA: a, stateB: b,
      profiles: { [a]: slim(cmp.kpis.a), [b]: slim(cmp.kpis.b) },
      mostDistinctContrast: cmp.mostDistinctContrast || null,
    },
    evidence: {
      files: ['state_summary.json', 'state_sport_summary.json'],
      fields: ['state', 'total_athletes', 'paralympic_athletes', 'summer_athletes', 'winter_athletes', 'sport_count'],
      rowCount: 52,
    },
  };
}

function buildWinterShareFacts({ entities }) {
  const map = getStateAggregateMap({});
  const all = Array.from(map.values())
    .filter((r) => (r.total || 0) >= 30)
    .map((r) => ({
      state: r.state,
      name: STATE_NAMES[r.state] || r.state,
      totalAthletes: r.total || 0,
      winterAthletes: r.winter || 0,
      winterShare: r.total ? (r.winter || 0) / r.total : 0,
    }))
    .sort((a, b) => b.winterShare - a.winterShare);
  let climate = null;
  const stateCode = entities?.states?.[0];
  if (stateCode) {
    const c = getStateClimate(stateCode);
    if (c) {
      climate = {
        state: stateCode,
        avgAnnualTempF: c.avg_annual_temp_f,
        avgAnnualPrecipIn: c.avg_annual_precip_in,
      };
    }
  }
  return {
    facts: {
      direction: entities?.direction || null,
      topWinterShareStates: all.slice(0, 10),
      bottomWinterShareStates: all.slice(-10).reverse(),
      climate,
      minAthletesFloor: 30,
    },
    evidence: {
      files: climate ? ['state_summary.json', 'climate_state_summary.json'] : ['state_summary.json'],
      fields: climate
        ? ['state', 'total_athletes', 'winter_athletes', 'avg_annual_temp_f', 'avg_annual_precip_in']
        : ['state', 'total_athletes', 'winter_athletes'],
      rowCount: 52,
    },
  };
}

/**
 * Build a broad "general" facts payload for the Ask page when the
 * question doesn't match any narrow intent. Carries enough breadth that
 * Gemini can answer most reasonable roster questions (state distribution,
 * hometown hubs, sport mix, season mix, Para representation, parity)
 * without inventing numbers. If a question can't be grounded in this
 * payload, Gemini should produce a short refusal — which the Ask page
 * surfaces with a friendly "I couldn't ground that in the roster"
 * message rather than the old hard-stop muted reply.
 */
function buildGeneralAskFacts() {
  const map = getStateAggregateMap({});
  const allStates = Array.from(map.values())
    .filter((r) => (r.total || 0) > 0)
    .sort((a, b) => (b.total || 0) - (a.total || 0))
    .map((r) => ({
      state: r.state,
      name: STATE_NAMES[r.state] || r.state,
      totalAthletes: r.total || 0,
      olympicAthletes: r.olympic || 0,
      paralympicAthletes: r.paralympic || 0,
      summerAthletes: r.summer || 0,
      winterAthletes: r.winter || 0,
      sportCount: r.sportCount || 0,
    }));
  const topStatesByCount = allStates.slice(0, 8);
  const bottomStatesByCount = allStates.slice(-8).reverse();
  const topStatesByDiversity = [...allStates]
    .sort((a, b) => (b.sportCount || 0) - (a.sportCount || 0))
    .slice(0, 8);
  const winterShareStates = allStates
    .filter((r) => r.totalAthletes >= 30)
    .map((r) => ({
      state: r.state,
      name: r.name,
      totalAthletes: r.totalAthletes,
      winterAthletes: r.winterAthletes,
      winterShare: r.totalAthletes ? r.winterAthletes / r.totalAthletes : 0,
    }))
    .sort((a, b) => b.winterShare - a.winterShare);
  const topWinterShareStates = winterShareStates.slice(0, 8);
  const topHubs = getTopHometownsScoped({}, 9999)
    .slice(0, 10)
    .map((h) => ({
      city: h.hometown_city,
      state: h.hometown_state,
      athletes: h.total_athletes,
    }));
  let parityStates = [];
  try {
    const lens = getParityLensData({ minAthletes: 30 });
    parityStates = (lens?.balancedRanking || []).slice(0, 8).map((r) => ({
      state: r.state,
      name: r.name,
      totalAthletes: r.total,
      paralympicAthletes: r.paralympic_athletes,
      paralympicShare: r.total ? r.paralympic_athletes / r.total : 0,
    }));
  } catch (_) {
    parityStates = [];
  }
  return {
    facts: {
      national: nationalSummary(),
      totalStatesWithAthletes: allStates.length,
      topStatesByCount,
      bottomStatesByCount,
      topStatesBySportDiversity: topStatesByDiversity,
      topHometownHubs: topHubs,
      topWinterShareStates,
      topParalympicShareStates: parityStates,
    },
    evidence: {
      files: ['state_summary.json', 'hometown_summary.json'],
      fields: [
        'state',
        'total_athletes',
        'olympic_athletes',
        'paralympic_athletes',
        'summer_athletes',
        'winter_athletes',
        'sport_count',
        'hometown_city',
        'hometown_state',
      ],
      rowCount: allStates.length + topHubs.length,
    },
  };
}

/**
 * Build the Ask the Analyst Gemini context. Carries the classified intent,
 * extracted entities, intent-specific facts, and an evidence manifest. The
 * `facts` field is populated from existing helpers so Gemini gets
 * ready-to-summarize numbers, not raw rows.
 *
 * @param {{ intent?: ?string, entities?: object, question?: string }} [opts]
 */
export function getAskContext({ intent = null, entities = null, question = '' } = {}) {
  const safeIntent = intent || 'unsupported_or_unsafe';
  const safeEntities = entities || {};
  const builder = INTENT_FACT_BUILDERS[safeIntent];
  let facts = {};
  let evidence = { files: [], fields: [], rowCount: 0 };
  if (builder) {
    try {
      const built = builder({ entities: safeEntities });
      facts = built.facts || {};
      evidence = built.evidence || evidence;
    } catch (_) {
      // Helper failed (likely missing data slice); leave facts empty so the
      // server falls back rather than promising data we can't back up.
    }
  }
  return {
    view: 'ask',
    question: question || '',
    intent: safeIntent,
    entities: safeEntities,
    facts,
    evidence,
    rules: {
      noNames: true,
      noMedals: true,
      noCausality: true,
      noPredictions: true,
      climateContextOnly: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Sanity check (NOT auto-invoked). Confirms each builder produces a
// JSON-serializable object when called with empty inputs. Run from a console
// after the store is initialised.
// ---------------------------------------------------------------------------
export function __sanityCheck() {
  const safe = (fn, args) => {
    const ctx = fn(args);
    JSON.stringify(ctx); // throws on circular / non-serializable
    return ctx;
  };
  // These rely on the store being initialised; callers should ensure that.
  void getStore;
  return {
    atlas: safe(getAtlasContext, { filters: {}, selectedState: null }),
    sport: safe(getSportContext, { sport: null, filters: {} }),
    parity: safe(getParityContext, { filters: {} }),
    compare: safe(getCompareContext, { stateA: null, stateB: null }),
    ask: safe(getAskContext, {}),
  };
}

// Keep an unused import reference quiet for STATE_NAMES (reserved for future
// label hydration inside this file).
void STATE_NAMES;
