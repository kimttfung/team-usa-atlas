/**
 * lib/gemini.js — frontend Gemini client.
 *
 * Talks to the local server's `POST /api/gemini/generate` endpoint
 * (the Gemini API key lives server-side and is never sent to the
 * browser). Always resolves — never rejects — so callers can branch
 * on `result.source` without a try/catch around the network layer.
 *
 * Returns either:
 *   { source: 'gemini',   task, result }  // Gemini answered cleanly
 *   { source: 'fallback', task, error, flags? }  // anything else
 *
 * The `error` codes the server emits are: `no_key`, `bad_task`,
 * `bad_json`, `empty`, `gemini_error`, `validation_failed`. The client
 * adds `network` and `timeout` for transport-level failures.
 */

import { getCachedContext, setCachedContext } from '../helpers/contextCache.js';
import { makeContextCacheKey } from '../helpers/cacheKey.js';

const ENDPOINT = '/api/gemini/generate';
// 40s — Gemini 3 Flash Lite typically returns in 2-8s but the heavier
// compare_insight schema (five narrative sections) can drift up toward
// 20-25s. 25s was leaving compare on a knife-edge; 40s is comfortably
// above observed worst cases while still recovering quickly from a
// truly hung call.
const TIMEOUT_MS = 40000;

async function postWithTimeout(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { source: 'fallback', task: body.task, error: `http_${resp.status}` };
    }
    return await resp.json();
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { source: 'fallback', task: body.task, error: 'timeout' };
    }
    return { source: 'fallback', task: body.task, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate an Ask the Analyst answer.
 *
 * @param {{ question: string, intent?: string, entities?: object,
 *           facts?: object, evidence?: object }} payload
 */
export async function generateAskAnswer(payload) {
  const body = {
    task: 'ask_answer',
    question: payload.question,
    context: {
      intent: payload.intent || null,
      entities: payload.entities || {},
      facts: payload.facts || {},
      evidence: payload.evidence || {},
    },
    schemaVersion: '1.0',
  };
  return postWithTimeout(body);
}

/**
 * Generate an insight card response (Atlas / Sport / Parity / Compare).
 * The result envelope's shape varies by task — the caller knows the
 * schema for the task it asked for.
 *
 * @param {string} task     One of: atlas_insight, sport_insight,
 *                          parity_insight, compare_insight.
 * @param {object} context  Compact context payload from helpers/context.js.
 * @param {object} [opts]   `{cacheKey?: string}` — when provided, the
 *                          result is memoised under that key for the
 *                          rest of the session.
 */
export async function generateInsight(task, context, opts = {}) {
  const cacheKey = opts.cacheKey || null;
  const body = { task, question: null, context: context || {}, schemaVersion: '1.0' };

  if (!cacheKey) return postWithTimeout(body);

  // Read-through cache, but only memoise *successful* Gemini calls so a
  // transient timeout doesn't permanently downgrade this context to
  // fallback for the rest of the session.
  const view = `gemini:${task}`;
  const hit = getCachedContext(view, cacheKey);
  if (hit) return hit;
  const result = await postWithTimeout(body);
  if (result && result.source === 'gemini') setCachedContext(view, cacheKey, result);
  return result;
}

/** Re-export so callers can build their own keys. */
export { makeContextCacheKey };
