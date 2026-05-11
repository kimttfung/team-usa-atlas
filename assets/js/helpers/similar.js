/**
 * helpers/similar.js — find statistically similar states
 *
 * Builds a 5-dimensional z-score profile for every state with athletes and
 * returns the N nearest neighbors (Euclidean distance in z-space) to a given
 * state. Also surfaces the dimension on which the neighbor is closest, so
 * callers can render a short "why" label.
 *
 * Dimensions (all sourced from getStateAggregateMap with no filters):
 *   - total         total athletes
 *   - sport_count   distinct sports
 *   - winter_share  winter / total
 *   - para_share    paralympic / total  (Paralympic share of all athletes)
 *
 * Exports:
 *   findSimilarStates(stateCode, { n = 3 }) -> [{ state, name, score,
 *     closestDim, closestLabel }, ...]  (empty array if stateCode unknown)
 */

import { STATE_NAMES } from '../data/store.js';
import { getStateAggregateMap } from './aggregates.js';

const DIMS = ['total', 'sport_count', 'winter_share', 'para_share'];

const DIM_LABELS = {
  total: 'similar total',
  sport_count: 'similar sport diversity',
  winter_share: 'similar winter share',
  para_share: 'similar Paralympic share',
};

function profileFor(agg) {
  const total = agg.total || 0;
  return {
    total,
    sport_count: agg.sportCount || 0,
    winter_share: total ? (agg.winter || 0) / total : 0,
    para_share: total ? (agg.paralympic || 0) / total : 0,
  };
}

function meanStd(values) {
  const n = values.length;
  if (!n) return { mean: 0, std: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / n);
  return { mean, std };
}

export function findSimilarStates(stateCode, { n = 3 } = {}) {
  if (!stateCode) return [];
  const aggMap = getStateAggregateMap({});
  const target = aggMap.get(stateCode);
  if (!target || !(target.total > 0)) return [];

  const entries = [];
  for (const [st, agg] of aggMap) {
    if (!(agg.total > 0)) continue;
    entries.push({ state: st, profile: profileFor(agg) });
  }
  if (entries.length < 2) return [];

  // Population mean/std per dimension across qualifying states.
  const stats = {};
  for (const dim of DIMS) {
    stats[dim] = meanStd(entries.map((e) => e.profile[dim]));
  }

  const zOf = (profile) => {
    const z = {};
    for (const dim of DIMS) {
      const { mean, std } = stats[dim];
      z[dim] = std ? (profile[dim] - mean) / std : 0;
    }
    return z;
  };

  const targetEntry = entries.find((e) => e.state === stateCode);
  if (!targetEntry) return [];
  const targetZ = zOf(targetEntry.profile);

  const scored = entries
    .filter((e) => e.state !== stateCode)
    .map((e) => {
      const z = zOf(e.profile);
      let sq = 0;
      let closestDim = DIMS[0];
      let closestDiff = Infinity;
      for (const dim of DIMS) {
        const d = z[dim] - targetZ[dim];
        sq += d * d;
        const abs = Math.abs(d);
        if (abs < closestDiff) {
          closestDiff = abs;
          closestDim = dim;
        }
      }
      return {
        state: e.state,
        name: STATE_NAMES[e.state] || e.state,
        score: Math.sqrt(sq),
        closestDim,
        closestLabel: DIM_LABELS[closestDim],
      };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, n);

  return scored;
}
