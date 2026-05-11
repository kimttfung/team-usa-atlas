/**
 * helpers/compare.js — side-by-side state comparison
 *
 * Returns a unified bundle for Compare Regions. Page is responsible for
 * binding it into the existing two-column DOM. Includes plain-language summary
 * bullets computed locally — no narrative claims.
 *
 * Return shape:
 *   {
 *     // legacy (unchanged):
 *     kpis, olyPara, sumWin, topSports, topHubs, climate,
 *     sharedSports, summaryBullets,
 *
 *     // added:
 *     atAGlance,              // string[3] — the three most informative truths
 *     similarities,           // string[]  — bullets where A and B are alike
 *     differences,            // string[]  — bullets where A and B differ meaningfully
 *     signatureSports: { a: [{sport, athletes}], b: [...] },     // top 3 per side
 *     hometownConcentration: {
 *       a: { topHubs: [{city,state,athletes}], top3Share, stateTotal },
 *       b: { ... },
 *     },
 *     seasonProfile: { a: string, b: string },                   // descriptive label
 *     mostDistinctContrast,   // string | null — single-sentence callout
 *   }
 */

import { getStore, STATE_NAMES } from '../data/store.js';
import { getStateSummary, getStateClimate, getStateSports, getStateHometowns } from './states.js';
import { getOlyParaSplit, getSummerWinterSplit, getNationalTotal, getScopedStateTotals, getTopHometownsScoped } from './aggregates.js';
import { explainMostDistinctContrast } from './explainers.js';

function pick(row, keys) {
  if (!row) return Object.fromEntries(keys.map((k) => [k, null]));
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

function fmtPct(ratio, digits = 1) {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

function fmtNum(n) {
  return n == null ? '—' : n.toLocaleString();
}

/**
 * Top-3 hometown-hub concentration for a single state. Share is the sum of the
 * top-3 hubs' athlete counts divided by the state's KPI total (scoped totals,
 * matching the rest of the Compare flow).
 */
export function getStateHubConcentration(stateCode) {
  if (!stateCode) return { topThreeShare: 0, topThreeHubs: [] };
  const top3 = getStateHometowns(stateCode, 3);
  const total = getScopedStateTotals(stateCode, {}).total || 0;
  const sum = top3.reduce((s, r) => s + (r.total_athletes || 0), 0);
  return {
    topThreeShare: total ? sum / total : 0,
    topThreeHubs: top3,
  };
}

// Memoised per-state stat bundle used by computeProfileLabels to derive
// quartile / median thresholds across every state with data.
let _allStateStatsCache = null;
function getAllStateStats() {
  if (_allStateStatsCache) return _allStateStatsCache;
  const store = getStore();
  const codes = new Set((store.stateSummary || []).map((r) => r.state).filter(Boolean));
  const map = new Map();
  for (const st of codes) {
    const sc = getScopedStateTotals(st, {});
    if (!sc.total) continue;
    const top3 = getStateHometowns(st, 3);
    const top3Sum = top3.reduce((s, r) => s + (r.total_athletes || 0), 0);
    map.set(st, {
      total: sc.total,
      sportCount: sc.sportCount || 0,
      winterShare: sc.total ? (sc.winter || 0) / sc.total : 0,
      paraShare: sc.paralympicShare || 0,
      top3HubShare: sc.total ? top3Sum / sc.total : 0,
    });
  }
  _allStateStatsCache = map;
  return map;
}

/**
 * Returns 1–3 neutral profile labels for a state, picked by score against
 * national thresholds. Falls back to ['Balanced Profile'] if nothing triggers.
 */
export function computeProfileLabels(stateCode) {
  const all = getAllStateStats();
  const me = all.get(stateCode);
  if (!me) return [];

  const values = [...all.values()];
  const sortedBy = (key) => values.map((v) => v[key]).sort((a, b) => a - b);
  const quantile = (arr, q) => arr.length
    ? arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * q)))]
    : 0;
  const q3Total = quantile(sortedBy('total'), 0.75);
  const q3Sport = quantile(sortedBy('sportCount'), 0.75);
  const medianPara = quantile(sortedBy('paraShare'), 0.5);

  const candidates = [];
  if (q3Total > 0 && me.total >= q3Total) {
    candidates.push({ label: 'High Athlete Count', score: 1 + me.total / q3Total });
  }
  if (q3Sport > 0 && me.sportCount >= q3Sport) {
    candidates.push({ label: 'Broad Sport Mix', score: 1 + me.sportCount / q3Sport });
  }
  if (me.winterShare > 0.50) {
    candidates.push({ label: 'Winter-Leaning', score: 1.2 + me.winterShare });
  } else if (me.winterShare < 0.25) {
    candidates.push({ label: 'Summer-Leaning', score: 1.0 + (1 - me.winterShare) * 0.5 });
  } else {
    candidates.push({ label: 'Mixed Seasons', score: 0.4 });
  }
  if (me.top3HubShare > 0.40) {
    candidates.push({ label: 'Concentrated Hubs', score: 1.1 + me.top3HubShare });
  } else if (me.top3HubShare < 0.20) {
    candidates.push({ label: 'Distributed Hubs', score: 1.0 + (1 - me.top3HubShare) * 0.4 });
  }
  if (medianPara > 0 && me.paraShare > medianPara) {
    candidates.push({ label: 'Higher Para Share', score: 1.0 + me.paraShare / medianPara });
  }

  candidates.sort((a, b) => b.score - a.score);
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    if (out.length >= 2) break;
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c.label);
  }
  return out.length ? out : ['Balanced Profile'];
}

export function compareStates(stA, stB) {
  if (!stA || !stB) return null;

  const sumA = getStateSummary(stA);
  const sumB = getStateSummary(stB);
  if (!sumA || !sumB) return null;

  // Re-derive numeric KPIs from participation so the Compare page uses the
  // same definitions as Atlas / Sport Explorer / Parity Lens (Olympic =
  // ≥1 Olympic participation row, etc). state_summary.json has a known
  // dual-classification drift that we don't want surfaced here.
  const scopedA = getScopedStateTotals(stA, {});
  const scopedB = getScopedStateTotals(stB, {});

  const climateA = getStateClimate(stA);
  const climateB = getStateClimate(stB);

  const sportsA = getStateSports(stA, 8);
  const sportsB = getStateSports(stB, 8);
  const hubsA   = getStateHometowns(stA, 6);
  const hubsB   = getStateHometowns(stB, 6);

  const olyParaA = getOlyParaSplit({ kind: 'state', state: stA });
  const olyParaB = getOlyParaSplit({ kind: 'state', state: stB });
  const sumWinA  = getSummerWinterSplit({ kind: 'state', state: stA });
  const sumWinB  = getSummerWinterSplit({ kind: 'state', state: stB });

  const national = getNationalTotal();
  const shareA = national ? scopedA.total / national : 0;
  const shareB = national ? scopedB.total / national : 0;

  // Build a state_summary-shaped KPI bundle from the scoped totals so the
  // existing Compare DOM continues to read the same field names.
  const buildKpi = (st, scoped, share) => ({
    state: st,
    name: STATE_NAMES[st] || st,
    total_athletes:      scoped.total,
    olympic_athletes:    scoped.olympic,
    paralympic_athletes: scoped.paralympic,
    summer_athletes:     scoped.summer,
    winter_athletes:     scoped.winter,
    sport_count:         scoped.sportCount,
    paralympic_share:    scoped.paralympicShare,
    balance_index:       scoped.balanceIndex,
    share,
  });

  const kpis = {
    a: buildKpi(stA, scopedA, shareA),
    b: buildKpi(stB, scopedB, shareB),
  };

  // Cross-A/B intersections
  const sportSetA = new Set(sportsA.map((r) => r.sport));
  const sportSetB = new Set(sportsB.map((r) => r.sport));
  const sharedSports = [...sportSetA].filter((s) => sportSetB.has(s));

  // Summary bullets — strictly factual, computed against the scoped (truth) KPIs.
  const a = kpis.a;
  const b = kpis.b;
  const bullets = [];

  if (a.total_athletes !== b.total_athletes) {
    const lead = a.total_athletes > b.total_athletes ? a : b;
    const trail = lead === a ? b : a;
    const diff = lead.total_athletes - trail.total_athletes;
    const ratio = trail.total_athletes ? (lead.total_athletes / trail.total_athletes).toFixed(1) : '∞';
    bullets.push(`${lead.name} fields ${fmtNum(diff)} more total athletes (${fmtNum(lead.total_athletes)} vs ${fmtNum(trail.total_athletes)}) — ${ratio}× the roster size.`);
  }

  if (a.sport_count !== b.sport_count) {
    const lead = a.sport_count > b.sport_count ? a : b;
    const trail = lead === a ? b : a;
    bullets.push(`${lead.name} spans ${lead.sport_count} sports versus ${trail.sport_count} for ${trail.name}.`);
  }

  if ((a.paralympic_share || 0) !== (b.paralympic_share || 0)) {
    const lead = (a.paralympic_share || 0) > (b.paralympic_share || 0) ? a : b;
    const trail = lead === a ? b : a;
    bullets.push(`${lead.name} has a higher Paralympic share (${fmtPct(lead.paralympic_share)}) than ${trail.name} (${fmtPct(trail.paralympic_share)}).`);
  }

  // Summer/Winter lean
  const winterShareA = a.total_athletes ? (a.winter_athletes || 0) / a.total_athletes : 0;
  const winterShareB = b.total_athletes ? (b.winter_athletes || 0) / b.total_athletes : 0;
  if (Math.abs(winterShareA - winterShareB) >= 0.05) {
    const winterLead = winterShareA > winterShareB ? a : b;
    const winterTrail = winterLead === a ? b : a;
    const winterLeadShare  = winterLead === a ? winterShareA : winterShareB;
    const winterTrailShare = winterTrail === a ? winterShareA : winterShareB;
    bullets.push(`Winter sports make up ${fmtPct(winterLeadShare)} of ${winterLead.name}'s athletes versus ${fmtPct(winterTrailShare)} for ${winterTrail.name}.`);
  }

  // Shared sports
  if (sharedSports.length) {
    const examples = sharedSports.slice(0, 3).join(', ');
    const noun = sharedSports.length === 1 ? 'sport' : 'sports';
    bullets.push(`The states share ${sharedSports.length} ${noun} in common${sharedSports.length > 3 ? ` (e.g. ${examples})` : ` — ${examples}`}.`);
  } else {
    bullets.push(`No top-8 sport overlaps between ${a.name} and ${b.name}.`);
  }

  // Climate context
  if (climateA && climateB) {
    const tempDiff = (climateA.avg_annual_temp_f || 0) - (climateB.avg_annual_temp_f || 0);
    const precipDiff = (climateA.avg_annual_precip_in || 0) - (climateB.avg_annual_precip_in || 0);
    if (Math.abs(tempDiff) >= 5 || Math.abs(precipDiff) >= 8) {
      const warmer = tempDiff > 0 ? kpis.a : kpis.b;
      const cooler = warmer === kpis.a ? kpis.b : kpis.a;
      const tempGap = Math.abs(tempDiff).toFixed(1);
      const wetter = precipDiff > 0 ? kpis.a : kpis.b;
      const drier  = wetter === kpis.a ? kpis.b : kpis.a;
      const precipGap = Math.abs(precipDiff).toFixed(1);
      bullets.push(`Climate context: ${warmer.name} averages ${tempGap}°F warmer than ${cooler.name}, with ${wetter.name} ${precipGap}″ wetter than ${drier.name} annually.`);
    }
  } else if (!climateA && climateB) {
    bullets.push(`No NOAA climate normals available for ${kpis.a.name}.`);
  } else if (climateA && !climateB) {
    bullets.push(`No NOAA climate normals available for ${kpis.b.name}.`);
  }

  // ---------------------------------------------------------------------------
  // Extended fields (atAGlance / similarities / differences / signature / etc.)
  // ---------------------------------------------------------------------------

  // Convenience scalars reused below.
  const paraShareA = a.paralympic_share || 0;
  const paraShareB = b.paralympic_share || 0;
  const tempA = climateA?.avg_annual_temp_f ?? null;
  const tempB = climateB?.avg_annual_temp_f ?? null;

  // Signature sports — top 3 per side from getStateSports.
  const signatureSports = {
    a: getStateSports(stA, 3).map((r) => ({ sport: r.sport, athletes: r.total_athletes })),
    b: getStateSports(stB, 3).map((r) => ({ sport: r.sport, athletes: r.total_athletes })),
  };

  // Hometown concentration — top 3 hubs and their share of the state's KPI total.
  // Source numerator and denominator from the same participation-derived layer
  // so the percentage stays internally consistent (state_summary.json has known
  // dual-classification drift vs. participation distinct counts).
  const top3A = getTopHometownsScoped({ state: stA }, 3);
  const top3B = getTopHometownsScoped({ state: stB }, 3);
  const sumTop3 = (rows) => rows.reduce((s, r) => s + (r.total_athletes || 0), 0);
  const shareOf = (sum, total) => (total ? sum / total : 0);

  const hometownConcentration = {
    a: {
      topHubs: top3A.map((r) => ({ city: r.hometown_city, state: r.hometown_state, athletes: r.total_athletes })),
      top3Share: shareOf(sumTop3(top3A), scopedA.total),
      stateTotal: scopedA.total,
    },
    b: {
      topHubs: top3B.map((r) => ({ city: r.hometown_city, state: r.hometown_state, athletes: r.total_athletes })),
      top3Share: shareOf(sumTop3(top3B), scopedB.total),
      stateTotal: scopedB.total,
    },
  };

  // Season profile — descriptive label from winter share.
  // < 0.10 Mostly Summer | 0.10–0.30 Mixed Season | >= 0.30 Winter-leaning
  const seasonLabel = (winterShare) => {
    if (winterShare < 0.10) return 'Mostly Summer';
    if (winterShare < 0.30) return 'Mixed Season';
    return 'Winter-leaning';
  };
  const seasonProfile = {
    a: seasonLabel(winterShareA),
    b: seasonLabel(winterShareB),
  };

  // ---- similarities -------------------------------------------------------
  // Thresholds: ±20% total, ±3 sport_count, ±0.05 winter share, ±5°F temp,
  // both-have-para, top-sport overlap.
  const similarities = [];
  const totalAvg = (a.total_athletes + b.total_athletes) / 2;
  const totalGap = Math.abs(a.total_athletes - b.total_athletes);
  if (totalAvg > 0 && totalGap / totalAvg <= 0.20) {
    similarities.push(`Both states have comparable total athlete counts (${fmtNum(a.total_athletes)} vs ${fmtNum(b.total_athletes)}).`);
  }
  if (Math.abs(a.sport_count - b.sport_count) <= 3) {
    similarities.push('Both states span a comparable number of sports.');
  }
  if ((a.olympic_athletes || 0) > 0 && (b.olympic_athletes || 0) > 0
      && (a.paralympic_athletes || 0) > 0 && (b.paralympic_athletes || 0) > 0) {
    similarities.push('Both states show Olympic and Paralympic representation.');
  }
  if (Math.abs(winterShareA - winterShareB) <= 0.05) {
    similarities.push('Both states have a similar winter share.');
  }
  if (sharedSports.length >= 1) {
    const examples = sharedSports.slice(0, 3).join(', ');
    similarities.push(`The states share ${sharedSports.length} sport${sharedSports.length === 1 ? '' : 's'} in their top 8 (e.g., ${examples}).`);
  }
  if (tempA != null && tempB != null && Math.abs(tempA - tempB) <= 5) {
    similarities.push('Both states have similar annual temperatures.');
  }

  // ---- differences --------------------------------------------------------
  // Thresholds (only emit when the gap is large):
  //   total >50%, sport_count >5, winter share >0.10, parity >0.05,
  //   top-3 hub concentration >0.10, temp >=10°F.
  const differences = [];
  if (totalAvg > 0 && totalGap / totalAvg > 0.50) {
    const lead = a.total_athletes > b.total_athletes ? a : b;
    const trail = lead === a ? b : a;
    const ratio = trail.total_athletes ? (lead.total_athletes / trail.total_athletes).toFixed(1) : '∞';
    differences.push(`${lead.name} fields ~${ratio}× more total athletes than ${trail.name}.`);
  }
  if (Math.abs(a.sport_count - b.sport_count) > 5) {
    const lead = a.sport_count > b.sport_count ? a : b;
    const trail = lead === a ? b : a;
    differences.push(`${lead.name} spans ${lead.sport_count - trail.sport_count} more sports than ${trail.name}.`);
  }
  if (Math.abs(winterShareA - winterShareB) > 0.10) {
    const winterLead = winterShareA > winterShareB ? a : b;
    const winterTrail = winterLead === a ? b : a;
    const winterLeadShare  = winterLead === a ? winterShareA : winterShareB;
    const winterTrailShare = winterTrail === a ? winterShareA : winterShareB;
    differences.push(`Winter sports make up ${fmtPct(winterLeadShare)} of ${winterLead.name}'s athletes vs ${fmtPct(winterTrailShare)} for ${winterTrail.name}.`);
  }
  if (Math.abs(paraShareA - paraShareB) > 0.05) {
    const lead = paraShareA > paraShareB ? a : b;
    const trail = lead === a ? b : a;
    const leadShare = lead === a ? paraShareA : paraShareB;
    const trailShare = trail === a ? paraShareA : paraShareB;
    differences.push(`${lead.name} has a higher Paralympic share (${fmtPct(leadShare)}) than ${trail.name} (${fmtPct(trailShare)}).`);
  }
  const hubShareA = hometownConcentration.a.top3Share;
  const hubShareB = hometownConcentration.b.top3Share;
  if (Math.abs(hubShareA - hubShareB) > 0.10) {
    const lead = hubShareA > hubShareB ? a : b;
    const trail = lead === a ? b : a;
    const leadShare = lead === a ? hubShareA : hubShareB;
    const trailShare = trail === a ? hubShareA : hubShareB;
    differences.push(`${lead.name}'s top hubs are more concentrated (${fmtPct(leadShare)} vs ${fmtPct(trailShare)}).`);
  }
  if (tempA != null && tempB != null && Math.abs(tempA - tempB) >= 10) {
    const warmer = tempA > tempB ? a : b;
    const cooler = warmer === a ? b : a;
    const gap = Math.abs(tempA - tempB).toFixed(0);
    differences.push(`${warmer.name} averages ${gap}°F warmer annually than ${cooler.name}.`);
  }

  // ---- atAGlance — exactly 3 bullets --------------------------------------
  // Pick the most informative truths from total, sport count, winter share,
  // Paralympic representation, climate. Express agreement as "Both …".
  const candidates = [];

  // Total athletes
  if (totalAvg > 0) {
    if (totalGap / totalAvg > 0.20) {
      const lead = a.total_athletes > b.total_athletes ? a : b;
      candidates.push({ score: totalGap / totalAvg, text: `${lead.name} has a larger overall athlete count.` });
    } else {
      candidates.push({ score: 0.05, text: 'Both states field comparable overall athlete counts.' });
    }
  }

  // Winter share
  if (Math.abs(winterShareA - winterShareB) > 0.05) {
    const lead = winterShareA > winterShareB ? a : b;
    candidates.push({ score: Math.abs(winterShareA - winterShareB) * 4, text: `${lead.name} has a higher winter athlete share.` });
  } else if (winterShareA < 0.10 && winterShareB < 0.10) {
    candidates.push({ score: 0.15, text: 'Both states are predominantly Summer-leaning.' });
  } else if (winterShareA >= 0.30 && winterShareB >= 0.30) {
    candidates.push({ score: 0.4, text: 'Both states lean Winter in their athlete mix.' });
  }

  // Paralympic representation
  const aHasPara = (a.paralympic_athletes || 0) > 0;
  const bHasPara = (b.paralympic_athletes || 0) > 0;
  if (aHasPara && bHasPara) {
    candidates.push({ score: 0.25, text: 'Both states show Olympic and Paralympic representation.' });
  } else if (aHasPara || bHasPara) {
    const lead = aHasPara ? a : b;
    candidates.push({ score: 0.4, text: `Only ${lead.name} shows Paralympic representation.` });
  }

  // Sport count
  if (Math.abs(a.sport_count - b.sport_count) > 5) {
    const lead = a.sport_count > b.sport_count ? a : b;
    candidates.push({ score: Math.abs(a.sport_count - b.sport_count) / 20, text: `${lead.name} spans a broader sport mix.` });
  } else if (Math.abs(a.sport_count - b.sport_count) <= 3) {
    candidates.push({ score: 0.08, text: 'Both states span a comparable number of sports.' });
  }

  // Climate
  if (tempA != null && tempB != null) {
    const tempDiff = Math.abs(tempA - tempB);
    if (tempDiff >= 10) {
      const warmer = tempA > tempB ? a : b;
      candidates.push({ score: tempDiff / 30, text: `${warmer.name} sits in a notably warmer climate.` });
    } else if (tempDiff <= 5) {
      candidates.push({ score: 0.05, text: 'Both states sit in similar annual temperature bands.' });
    }
  }

  // Take top 3 by score, dedup.
  const atAGlance = [];
  const seen = new Set();
  candidates.sort((x, y) => y.score - x.score);
  for (const c of candidates) {
    if (atAGlance.length >= 3) break;
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    atAGlance.push(c.text);
  }
  // Pad to exactly 3 with safe fallbacks if needed.
  const fallbacks = [
    `${a.name} and ${b.name} both contribute to Team USA's roster.`,
    'Both states have a measurable share of national athletes.',
    'Both states appear in the participation data.',
  ];
  for (const f of fallbacks) {
    if (atAGlance.length >= 3) break;
    if (!seen.has(f)) { atAGlance.push(f); seen.add(f); }
  }

  // ---- mostDistinctContrast ----------------------------------------------
  // Normalized gap across (total, sport_count, winter_share, para_share, top3_hub_share).
  // Counts use |a-b| / mean(a,b); shares (already 0–1) use raw |a-b|.
  const dims = [
    { key: 'total', a: a.total_athletes, b: b.total_athletes, kind: 'count' },
    { key: 'sport_count', a: a.sport_count, b: b.sport_count, kind: 'count' },
    { key: 'winter_share', a: winterShareA, b: winterShareB, kind: 'share' },
    { key: 'para_share', a: paraShareA, b: paraShareB, kind: 'share' },
    { key: 'top3_hub_share', a: hubShareA, b: hubShareB, kind: 'share' },
  ];
  const scored = dims.map((d) => {
    const gap = Math.abs(d.a - d.b);
    const mean = (d.a + d.b) / 2;
    const norm = d.kind === 'share' ? gap : (mean > 0 ? gap / mean : 0);
    return { ...d, gap, norm };
  });
  scored.sort((x, y) => y.norm - x.norm);
  const top = scored[0];

  // Threshold: <0.5 normalized gap → not distinct enough.
  let mostDistinctContrast = null;
  let mostDistinctContrastFacts = null;
  if (top && top.norm >= 0.5) {
    const higher = top.a > top.b ? a : b;
    const other  = higher === a ? b : a;
    const higherTotal = higher === a ? a.total_athletes : b.total_athletes;
    const otherTotal  = other  === a ? a.total_athletes : b.total_athletes;
    const higherSportCount = higher === a ? a.sport_count : b.sport_count;
    const otherSportCount  = other  === a ? a.sport_count : b.sport_count;
    const higherHubShare = higher === a ? hubShareA : hubShareB;
    const otherHubShare  = other  === a ? hubShareA : hubShareB;

    mostDistinctContrastFacts = Object.freeze({
      metric: top.key,
      higherState: higher.state,
      otherState: other.state,
      higherStateName: higher.name,
      otherStateName: other.name,
      higherValue: top.a > top.b ? top.a : top.b,
      otherValue:  top.a > top.b ? top.b : top.a,
      higherSportCount,
      otherSportCount,
      higherTotal,
      otherTotal,
      higherHubShare,
      otherHubShare,
      normalisedGap: top.norm,
    });
    mostDistinctContrast = explainMostDistinctContrast(mostDistinctContrastFacts);
  }

  return {
    kpis,
    olyPara: { a: olyParaA, b: olyParaB },
    sumWin:  { a: sumWinA, b: sumWinB },
    topSports: { a: sportsA, b: sportsB },
    topHubs:   { a: hubsA, b: hubsB },
    climate:   { a: climateA, b: climateB },
    sharedSports,
    summaryBullets: bullets.slice(0, 6),

    // extended
    atAGlance,
    similarities,
    differences,
    signatureSports,
    hometownConcentration,
    seasonProfile,
    mostDistinctContrast,
    mostDistinctContrastFacts,
  };
}
