/**
 * helpers/intent.js — analyst intent taxonomy + classifier.
 *
 * A small, controlled set of analyst intents. Each suggested-question chip in
 * `analyst.js` declares its canonical intent via this enum. The classifier is
 * also used to label free-text questions before they're routed to a handler
 * (or to a rephrased safe question via `guardrails.js`).
 */

import { checkSafety } from './guardrails.js';

export const INTENTS = Object.freeze({
  TOP_STATES:            'top_states',
  TOP_HOMETOWN_HUBS:     'top_hometown_hubs',
  SPORT_FOOTPRINT:       'sport_footprint',
  SPORT_CONCENTRATION:   'sport_concentration',
  PARITY_STATES:         'parity_states',
  PARITY_HUBS:           'parity_hubs',
  PARITY_SPORTS:         'parity_sports',
  COMPARE_STATES:        'compare_states',
  WINTER_SHARE:          'winter_share',
  SPORT_DIVERSITY:       'sport_diversity',
  CLIMATE_CONTEXT:       'climate_context',
  UNSUPPORTED_OR_UNSAFE: 'unsupported_or_unsafe',
});

/**
 * @typedef {Object} Classification
 * @property {'ok'|'rephrased'|'rejected'} status
 * @property {string} intent
 * @property {Object} entities
 * @property {string} safeQuestion
 * @property {string} [reason]
 */

// --- Entity extraction --------------------------------------------------

const STATE_CODES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
  'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
  'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR','VI',
];

const STATE_NAME_TO_CODE = Object.freeze({
  alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA', colorado:'CO',
  connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA', hawaii:'HI', idaho:'ID',
  illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS', kentucky:'KY', louisiana:'LA',
  maine:'ME', maryland:'MD', massachusetts:'MA', michigan:'MI', minnesota:'MN', mississippi:'MS',
  missouri:'MO', montana:'MT', nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ',
  'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND', ohio:'OH',
  oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC',
  'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT', virginia:'VA',
  washington:'WA', 'west virginia':'WV', wisconsin:'WI', wyoming:'WY',
});

const SPORT_KEYWORDS = [
  'gymnastics','swimming','track','field','athletics','basketball','soccer','football','baseball',
  'softball','tennis','golf','wrestling','boxing','cycling','rowing','sailing','skiing','snowboard',
  'snowboarding','skating','hockey','curling','bobsled','luge','skeleton','biathlon','volleyball',
  'water polo','diving','fencing','judo','taekwondo','archery','shooting','equestrian','triathlon',
  'rugby','surfing','climbing','skateboarding','breaking',
];

function extractEntities(text) {
  const entities = {};
  const lower = text.toLowerCase();

  const codes = new Set();
  const upper = text.toUpperCase();
  for (const code of STATE_CODES) {
    const re = new RegExp(`\\b${code}\\b`);
    if (re.test(upper)) codes.add(code);
  }
  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
    if (lower.includes(name)) codes.add(code);
  }
  if (codes.size > 0) entities.states = Array.from(codes);

  const sports = [];
  for (const s of SPORT_KEYWORDS) {
    if (lower.includes(s)) sports.push(s);
  }
  if (sports.length) entities.sports = Array.from(new Set(sports));

  if (/\bparalympic\b/i.test(text)) entities.program = 'Paralympic';
  else if (/\bolympic\b/i.test(text)) entities.program = 'Olympic';

  if (/\bwinter\b/i.test(text)) entities.season = 'Winter';
  else if (/\bsummer\b/i.test(text)) entities.season = 'Summer';

  // Direction qualifier — captures whether the user is asking about the
  // high end ("most/top/largest/highest") or low end ("least/fewest/
  // smallest/lowest/bottom") of a distribution. Gemini reads this to
  // pick the right slice (topXxx vs bottomXxx) from the facts payload.
  const wantsBottom = /\b(least|fewest|smallest|lowest|bottom|worst|minimum|min|lowest[-\s]ranking|fewest[-\s]athletes)\b/i.test(text);
  const wantsTop = /\b(most|top|largest|highest|biggest|maximum|max|leading|leaders?)\b/i.test(text);
  if (wantsBottom && !wantsTop) entities.direction = 'bottom';
  else if (wantsTop && !wantsBottom) entities.direction = 'top';

  return entities;
}

// --- Intent classification ----------------------------------------------

/**
 * Pick the canonical intent from a free-text question. Order matters: more
 * specific patterns are tested first so generic keywords don't shadow them.
 */
function pickIntent(text) {
  const t = text.toLowerCase();

  if (/\bcompare\b/.test(t) || /\b(vs\.?|versus)\b/.test(t)) return INTENTS.COMPARE_STATES;
  if (/\bclimate\b|\btemperature\b|\bnoaa\b|\bprecip/.test(t)) return INTENTS.CLIMATE_CONTEXT;

  const mentionsHub = /\b(hometown|hometowns|hub|hubs|city|cities|town|towns)\b/.test(t);
  const mentionsSport = /\b(sport|sports|discipline|disciplines)\b/.test(t);
  const mentionsState = /\b(state|states)\b/.test(t);
  const mentionsPara = /\bparalympic\b/.test(t) || /\bparity\b/.test(t) || /\bbalanced?\b/.test(t);
  const mentionsWinter = /\bwinter\b/.test(t);
  const mentionsConcentration = /\bconcentrat|\btop[-\s]?3\b|\bgeographically\b/.test(t);
  const mentionsDiversity = /\bdiversit|\bbreadth\b|\bbroad(est)?\b|\bmost\s+sports?\b/.test(t);
  const mentionsFootprint = /\bfootprint|\bcoverage\b|\bappear\s+across|\bmost\s+states\b/.test(t);

  if (mentionsPara && mentionsHub) return INTENTS.PARITY_HUBS;
  if (mentionsPara && mentionsSport) return INTENTS.PARITY_SPORTS;
  if (mentionsPara) return INTENTS.PARITY_STATES;

  // Hub mentions take precedence over generic winter/diversity matching so
  // questions like "hometown hubs for winter sports" or "hubs with broadest
  // diversity" route to the dedicated hub handlers (they exist as
  // TOP_HOMETOWN_HUBS chips with hidden:true labels).
  if (mentionsHub && (mentionsWinter || mentionsDiversity)) return INTENTS.TOP_HOMETOWN_HUBS;

  if (mentionsWinter && mentionsState) return INTENTS.WINTER_SHARE;

  if (mentionsSport && mentionsConcentration) return INTENTS.SPORT_CONCENTRATION;
  if (mentionsSport && mentionsFootprint) return INTENTS.SPORT_FOOTPRINT;
  if (mentionsDiversity && mentionsState) return INTENTS.SPORT_DIVERSITY;

  if (mentionsHub) return INTENTS.TOP_HOMETOWN_HUBS;
  if (mentionsState) return INTENTS.TOP_STATES;

  return INTENTS.UNSUPPORTED_OR_UNSAFE;
}

/**
 * Classify a free-text analyst question.
 *
 * @param {string} text
 * @returns {Classification}
 */
export function classifyAnalystQuestion(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return {
      status: 'rejected',
      intent: INTENTS.UNSUPPORTED_OR_UNSAFE,
      entities: {},
      safeQuestion: '',
      reason: 'Empty question.',
    };
  }

  const safety = checkSafety(text);
  if (!safety.safe) {
    return {
      status: 'rephrased',
      intent: INTENTS.UNSUPPORTED_OR_UNSAFE,
      entities: extractEntities(text),
      safeQuestion: safety.rephrased || '',
      reason: safety.reason,
    };
  }

  const intent = pickIntent(text);
  const entities = extractEntities(text);

  if (intent === INTENTS.UNSUPPORTED_OR_UNSAFE) {
    return {
      status: 'rejected',
      intent,
      entities,
      safeQuestion: '',
      reason: "I can only answer aggregate questions about athlete geography, sports, parity, and climate context. Try one of the suggested chips.",
    };
  }

  return {
    status: 'ok',
    intent,
    entities,
    safeQuestion: text.trim(),
  };
}
