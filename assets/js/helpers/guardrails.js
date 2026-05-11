/**
 * helpers/guardrails.js — shared guardrail rules for Ask the Analyst (and
 * future Gemini-powered analyst routes).
 *
 * Centralizes the vocabulary and rules that keep responses descriptive,
 * sourced, and free of performance / causal / value-judgment language.
 *
 *   - DISALLOWED_TOPICS — broad topics the app does not surface
 *   - UNSAFE_WORDS     — trigger vocabulary that requires rephrasing
 *   - SAFE_LANGUAGE    — preferred substitutions for unsafe phrasing
 *   - RESPONSE_RULES   — shape / voice rules every analyst response follows
 *   - REPHRASE_RULES   — pattern-based rewrites for unsafe free-text questions
 */

export const DISALLOWED_TOPICS = Object.freeze([
  'medals',
  'medal counts',
  'podium finishes',
  'rankings of athletes',
  'finish times',
  'scores',
  'individual athlete biographies',
  'athlete names',
  'athlete ages',
  'athlete heights',
  'athlete photos',
  'per-capita comparisons',
  'population-adjusted rates',
  'predictions of future performance',
  'causal claims about climate',
  'value judgments about programs',
]);

export const UNSAFE_WORDS = Object.freeze([
  'best',
  'worst',
  'winner',
  'winners',
  'champion',
  'champions',
  'medal',
  'medals',
  'medalist',
  'medalists',
  'podium',
  'gold',
  'silver',
  'bronze',
  'produces',
  'produced',
  'predicts',
  'predicted',
  'causes',
  'caused',
  'successful',
  'improving',
  'declining',
  'underperforming',
  'per capita',
  'per million',
  'population-adjusted',
  'normalized by population',
]);

export const SAFE_LANGUAGE = Object.freeze({
  best: 'highest count of',
  worst: 'lowest count of',
  winner: 'state with the most athletes',
  winners: 'states with the most athletes',
  champion: 'state with the most athletes',
  champions: 'states with the most athletes',
  medal: 'athlete count',
  medals: 'athlete counts',
  produces: 'has the most',
  predicts: 'is associated with',
  causes: 'co-occurs with',
  successful: 'high-count',
  improving: 'snapshot only — trends are not in the data',
  underperforming: 'snapshot only — trends are not in the data',
  'per capita': 'by total count',
  'per million': 'by total count',
});

export const RESPONSE_RULES = Object.freeze({
  voice: Object.freeze({
    headingCase: 'title',
    bodyCase: 'sentence',
    forbidSuperlatives: true,
    forbidCausalLanguage: true,
    datasetWordRestrictedToMethodology: true,
  }),
  shape: Object.freeze({
    requireHeadline: true,
    bullets: Object.freeze({ min: 2, max: 4 }),
    requireEvidence: true,
    requireFollowUps: true,
  }),
  evidence: Object.freeze({
    mustListFiles: true,
    mustListFields: true,
    mustListRowCount: true,
    mustBeGeneratedDeterministically: true,
  }),
});

/**
 * @typedef {Object} RephraseRule
 * @property {string} name
 * @property {(text: string) => boolean} test
 * @property {string} declineReason
 * @property {string} safeQuestionId
 */

/** @type {ReadonlyArray<RephraseRule>} */
export const REPHRASE_RULES = Object.freeze([
  {
    name: 'best-state-athletes',
    test: (t) =>
      /\b(best|top performing|most successful|winning|winners?|worst)\b.*\b(states?)\b/i.test(t)
      && /\b(athletes?|performance|success|win|winning|champions?|talent|medals?)\b/i.test(t),
    declineReason: "I can't answer performance or causality questions in a sourced way. A safer aggregate version is:",
    safeQuestionId: 'top-states-athletes',
  },
  {
    name: 'best-sport',
    test: (t) =>
      /\b(best|top performing|most successful|winning|worst)\b.*\b(sports?)\b/i.test(t)
      || /\b(sports?)\b.*\bis\s+(the\s+)?(best|most successful|top)\b/i.test(t),
    declineReason: "I can't rank sports by success or value. A safer aggregate version is:",
    safeQuestionId: 'sports-broadest-state-coverage',
  },
  {
    name: 'best-city',
    test: (t) =>
      /\b(best|top performing|most successful|winning|worst)\b.*\b(city|cities|hometown|town|towns)\b/i.test(t)
      || /\b(city|cities|hometown|town|towns)\b.*\bis\s+(the\s+)?(best|most successful|top)\b/i.test(t),
    declineReason: "I can't rank hometowns by success or value. A safer aggregate version is:",
    safeQuestionId: 'top-hometown-hubs',
  },
  {
    name: 'improving-declining',
    test: (t) =>
      /\b(improving|declining|getting better|falling behind|underperforming|on the rise|in decline|trending up|trending down)\b/i.test(t)
      && /\b(states?|sports?)\b/i.test(t),
    declineReason: "I can't answer trend or improvement questions — the data is a single-snapshot roster.",
    safeQuestionId: 'top-states-athletes',
  },
  {
    name: 'climate-causation',
    test: (t) =>
      /\bclimate\b/i.test(t)
      && /\b(produces?|produced|predicts?|predicted|causes?|caused|leads? to|led to|makes?|made|explains?|explained|drives?|drove)\b/i.test(t),
    declineReason: "I can't make causal claims about climate. A safer descriptive version is:",
    safeQuestionId: 'high-winter-share',
  },
  {
    name: 'produces-champions',
    test: (t) =>
      /\b(produces?|produced|predicts?|predicted|causes?|caused|leads? to|led to|makes?|made|explains?|explained)\b.*\b(champions?|winners?|medals?|medalists?|talent|success|gold)\b/i.test(t),
    declineReason: "I can't make causal claims about athlete outcomes. A safer descriptive version is:",
    safeQuestionId: 'top-states-athletes',
  },

  // ---- Phase 2 categories: medal/performance, predictive, causal-talent ----

  {
    name: 'medal-or-performance',
    test: (t) =>
      /\b(medals?|medalists?|podium|gold|silver|bronze|wins?|won|champion(?:s|ship)?|results?|scores?|finish(?:ing)? times?|rankings?|best performer|standings?)\b/i.test(t),
    declineReason: "Medal and performance outcomes aren't in the data. Try a roster-geography question instead.",
    safeQuestionId: 'top-states-athletes',
  },
  {
    name: 'individual-athlete-request',
    test: (t) =>
      /\b(who\s+(?:are|is)\s+the\s+athletes?|tell\s+me\s+about|profile|biograph(?:y|ies)|photos?|ages?|heights?|named?\s+athletes?|name\s+of)\b/i.test(t)
      || /\b(where\s+is|where['’]s)\b.*\bfrom\b/i.test(t)
      || /\b(simone\s+biles|michael\s+phelps|katie\s+ledecky|sha['’]?carri\s+richardson|noah\s+lyles)\b/i.test(t),
    declineReason: "Individual athletes aren't surfaced in the app. Try an aggregate hometown or sport question.",
    safeQuestionId: 'top-hometown-hubs',
  },
  {
    name: 'per-capita-request',
    test: (t) =>
      /\b(per\s+capita|per\s+million|per\s+thousand|population[-\s]adjusted|normalized\s+by\s+population|rate\s+per|capita)\b/i.test(t),
    declineReason: "Per-capita comparisons require population data this app doesn't include. Try a count-based question.",
    safeQuestionId: 'top-states-athletes',
  },
]);

/**
 * Run the rephrase rules against a free-text question.
 * Returns the first match, or null if no rule fires.
 *
 * @param {string} text
 * @returns {{ name: string, declineReason: string, safeQuestionId: string } | null}
 */
export function applyRephraseRules(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const rule of REPHRASE_RULES) {
    if (rule.test(text)) {
      return {
        name: rule.name,
        declineReason: rule.declineReason,
        safeQuestionId: rule.safeQuestionId,
      };
    }
  }
  return null;
}

/**
 * Lightweight safety check. Returns:
 *   { safe: true }                                   — passes guardrails
 *   { safe: false, reason, rephrased: safeQuestionId } — caller should rephrase
 *
 * @param {string} text
 * @returns {{ safe: boolean, reason?: string, rephrased?: string }}
 */
export function checkSafety(text) {
  const hit = applyRephraseRules(text);
  if (!hit) return { safe: true };
  return { safe: false, reason: hit.declineReason, rephrased: hit.safeQuestionId };
}
