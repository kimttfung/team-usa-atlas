/**
 * server/geminiClient.js
 *
 * Adapter around `@google/genai`. The `GoogleGenAI` instance is built
 * on the first call so the server can boot even when `GEMINI_API_KEY`
 * is missing (the endpoint then returns `ok:false` and the frontend
 * renders its deterministic fallback).
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { buildPrompt, SYSTEM_INSTRUCTION } from './prompts.js';
import { getSchemaForTask } from './schemas.js';

let _ai = null;

function getAI() {
  if (_ai) return _ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('Missing GEMINI_API_KEY'), { code: 'no_key' });
  }
  _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

const DEFAULT_GENERATION = Object.freeze({
  temperature: 0.2,
  topP: 0.8,
  maxOutputTokens: 900,
  // Gemini 3 introduced `thinkingLevel` (replacing the older
  // `thinkingBudget` knob). "minimal" tells Flash-Lite to skip extended
  // reasoning and go straight to the structured-output schema, which
  // cuts typical latency roughly in half. Our prompts are small and the
  // schema is strict, so the marginal quality gain from deeper thinking
  // is not worth the wall-time cost on these summary tasks.
  // See https://ai.google.dev/gemini-api/docs/thinking
  thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
});

/**
 * Generate a structured response for one of the supported tasks.
 *
 * @param {{ task: string, question?: string|null, context: object,
 *           model?: string }} params
 * @returns {Promise<object>} the parsed JSON result.
 * @throws  {Error} on missing key, missing schema, network failure, or
 *                  when the response cannot be parsed as JSON.
 */
export async function generate({ task, question, context, model }) {
  const schema = getSchemaForTask(task);
  if (!schema) {
    throw Object.assign(new Error(`Unknown task: ${task}`), { code: 'bad_task' });
  }

  const ai = getAI();
  const modelName = model || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const prompt = buildPrompt({ task, question, context });

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      ...DEFAULT_GENERATION,
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });

  const text = response?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('Empty response from Gemini'), { code: 'empty' });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error('Gemini response was not valid JSON'), {
      code: 'bad_json',
      cause: err,
      raw: text.slice(0, 500),
    });
  }
}
