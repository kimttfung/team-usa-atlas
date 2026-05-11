/**
 * server/schemas.js
 *
 * JSON Schemas passed to Gemini via `responseSchema`. Gemini will return JSON
 * matching the shape (Google's structured-output mode enforces this on the
 * server side), but we also re-validate locally in `validate.js` so any
 * drift produces a clean fallback rather than a runtime error in the UI.
 *
 * Schemas mirror the front-end response factories in
 * `assets/js/helpers/responseSchemas.js` so the two sides stay in lockstep.
 */

import { Type } from '@google/genai';

const stringArray = (min, max, description) => ({
  type: Type.ARRAY,
  minItems: min,
  maxItems: max,
  items: { type: Type.STRING, description },
});

/** Insight card schema — used by Atlas / Sport / Parity. */
export const INSIGHT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: 'Short title for the insight card. No more than 8 words.',
    },
    bullets: stringArray(
      4,
      6,
      'One concise, neutral, data-grounded bullet. Aim to cover a distinct ' +
      'facet across bullets — e.g. season (summer/winter), program ' +
      '(Olympic/Paralympic), top hometown hubs or sports, geographic spread, ' +
      'and descriptive climate context when provided.',
    ),
    caveat: {
      type: Type.STRING,
      description: 'One short caveat. Mention descriptive context only when relevant.',
    },
    followUps: stringArray(1, 3, 'Short follow-up chip label.'),
  },
  required: ['title', 'bullets', 'caveat', 'followUps'],
  propertyOrdering: ['title', 'bullets', 'caveat', 'followUps'],
};

/** Ask the Analyst schema — adds a small results table. */
export const ASK_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: 'Short answer title. No more than 10 words.',
    },
    bullets: stringArray(2, 4, 'One concise, neutral, sourced bullet.'),
    table: {
      type: Type.OBJECT,
      properties: {
        columns: stringArray(2, 5, 'Column header.'),
        rows: {
          type: Type.ARRAY,
          minItems: 0,
          maxItems: 10,
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              value: { type: Type.STRING },
              secondary: { type: Type.STRING },
              note: { type: Type.STRING },
            },
            required: ['label', 'value'],
            propertyOrdering: ['label', 'value', 'secondary', 'note'],
          },
        },
      },
      required: ['columns', 'rows'],
      propertyOrdering: ['columns', 'rows'],
    },
    caveat: {
      type: Type.STRING,
      description: 'One short caveat. Stay descriptive; never causal.',
    },
    followUps: stringArray(1, 3, 'Short follow-up chip label.'),
  },
  required: ['title', 'bullets', 'table', 'caveat', 'followUps'],
  propertyOrdering: ['title', 'bullets', 'table', 'caveat', 'followUps'],
};

/** Compare Regions schema — five narrative sections. */
export const COMPARE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'Title naming both states.' },
    summaryBullets: stringArray(3, 5, 'Top-line summary bullet.'),
    atAGlance: stringArray(3, 5, 'Short at-a-glance contrast bullet.'),
    similarities: stringArray(1, 4, 'One similarity bullet.'),
    differences: stringArray(1, 4, 'One difference bullet.'),
    mostDistinctContrast: {
      type: Type.STRING,
      description: 'One sentence naming the metric where the two states diverge most.',
    },
    caveat: { type: Type.STRING, description: 'One short caveat.' },
    followUps: stringArray(1, 3, 'Short follow-up chip label.'),
  },
  required: [
    'title',
    'summaryBullets',
    'atAGlance',
    'similarities',
    'differences',
    'mostDistinctContrast',
    'caveat',
    'followUps',
  ],
  propertyOrdering: [
    'title',
    'summaryBullets',
    'atAGlance',
    'similarities',
    'differences',
    'mostDistinctContrast',
    'caveat',
    'followUps',
  ],
};

const TASK_TO_SCHEMA = Object.freeze({
  ask_answer:      ASK_SCHEMA,
  atlas_insight:   INSIGHT_SCHEMA,
  sport_insight:   INSIGHT_SCHEMA,
  parity_insight:  INSIGHT_SCHEMA,
  compare_insight: COMPARE_SCHEMA,
});

export const VALID_TASKS = Object.freeze(Object.keys(TASK_TO_SCHEMA));

export function getSchemaForTask(task) {
  return TASK_TO_SCHEMA[task] || null;
}
