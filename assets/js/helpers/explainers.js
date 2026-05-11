/**
 * helpers/explainers.js — voice/copy layer.
 *
 * Pure functions that take `facts` objects produced by helpers and return
 * human-readable sentences. Keeping the prose here decouples voice from
 * data computation so a future LLM call can resummarise the same `facts` in
 * its own voice without us rewriting the helpers.
 *
 * Voice rules:
 *   - Title Case headings, sentence case body
 *   - No "best/winner/produces/predicts/successful/improving/underperforming"
 *   - Descriptive only, no causal claims
 */

function fmtPct(ratio, digits = 1) {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * @typedef {Object} MostDistinctContrastFacts
 * @property {string} metric              // 'total'|'sport_count'|'winter_share'|'para_share'|'top3_hub_share'
 * @property {string} higherState         // state code with the higher value
 * @property {string} otherState          // state code with the lower / contrasting value
 * @property {string} higherStateName
 * @property {string} otherStateName
 * @property {number} higherValue
 * @property {number} otherValue
 * @property {number} higherSportCount
 * @property {number} otherSportCount
 * @property {number} higherTotal
 * @property {number} otherTotal
 * @property {number} higherHubShare
 * @property {number} otherHubShare
 * @property {number} normalisedGap
 */

/**
 * Render the "most distinct contrast" sentence for the Compare view from
 * structured facts. Returns null when no contrast was found.
 *
 * @param {?MostDistinctContrastFacts} facts
 * @returns {?string}
 */
export function explainMostDistinctContrast(facts) {
  if (!facts) return null;
  const { metric, higherStateName: higher, otherStateName: other,
    higherSportCount, otherSportCount, higherTotal, otherTotal,
    higherHubShare, otherHubShare } = facts;
  switch (metric) {
    case 'winter_share':
      if (otherSportCount > higherSportCount) {
        return `${higher} has a much higher winter athlete share, while ${other} has a broader overall sport mix.`;
      }
      return `${higher} has a much higher winter athlete share, while ${other} leans Summer.`;
    case 'para_share':
      if (otherTotal > higherTotal) {
        return `${higher} has a much higher Paralympic share, while ${other} has a larger overall athlete count.`;
      }
      return `${higher} has a much higher Paralympic share, while ${other} skews more Olympic.`;
    case 'top3_hub_share':
      return `${higher} has a much higher top-hub concentration (${fmtPct(higherHubShare)}), while ${other} has a more distributed hometown footprint (${fmtPct(otherHubShare)}).`;
    case 'total':
      return `${higher} has a much larger overall athlete count, while ${other} fields a more focused roster.`;
    case 'sport_count':
      return `${higher} has a much broader sport mix, while ${other} is more specialized.`;
    default:
      return null;
  }
}
