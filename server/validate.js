/**
 * server/validate.js
 *
 * Post-Gemini validation. Even when `responseSchema` is enforced,
 * we still re-check structure and run a banned-phrase scan. Any
 * failure flips the response to the deterministic fallback path
 * on the frontend. We never regenerate — demos must not stall.
 */

const BANNED_PHRASES = [
  'best',
  'worst',
  'successful',
  'success rate',
  'produces',
  'causes',
  'leads to',
  'results in',
  'because of climate',
  'champions',
  'winners',
  'medals',
  'medalists',
  'podium',
  'finish time',
  'score',
  'ranked as the best',
  'pipeline',
  'talent factory',
];

const BULLET_MAX_CHARS = 240;
const TITLE_MAX_WORDS = 12;

function wordCount(str) {
  return String(str || '').trim().split(/\s+/).filter(Boolean).length;
}

function containsBanned(text) {
  if (typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return phrase;
  }
  return null;
}

function scanArray(arr, flags, label) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    if (item.length > BULLET_MAX_CHARS) {
      flags.push(`${label}_too_long`);
    }
    const banned = containsBanned(item);
    if (banned) flags.push(`banned:${banned}@${label}`);
  }
}

/**
 * @param {object|null} parsed The JSON object Gemini returned.
 * @param {string} task The task identifier (used to pick the right
 *   required-field check).
 * @returns {{ ok: boolean, flags: string[] }}
 */
export function validateGeminiResult(parsed, task) {
  const flags = [];
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, flags: ['not_object'] };
  }

  if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
    flags.push('missing_title');
  } else if (wordCount(parsed.title) > TITLE_MAX_WORDS) {
    flags.push('title_too_long');
  } else {
    const banned = containsBanned(parsed.title);
    if (banned) flags.push(`banned:${banned}@title`);
  }

  if (typeof parsed.caveat === 'string') {
    const banned = containsBanned(parsed.caveat);
    if (banned) flags.push(`banned:${banned}@caveat`);
  }

  scanArray(parsed.bullets,         flags, 'bullets');
  scanArray(parsed.followUps,       flags, 'followUps');
  scanArray(parsed.summaryBullets,  flags, 'summaryBullets');
  scanArray(parsed.atAGlance,       flags, 'atAGlance');
  scanArray(parsed.similarities,    flags, 'similarities');
  scanArray(parsed.differences,     flags, 'differences');

  if (typeof parsed.mostDistinctContrast === 'string') {
    const banned = containsBanned(parsed.mostDistinctContrast);
    if (banned) flags.push(`banned:${banned}@mostDistinctContrast`);
  }

  if (task === 'ask_answer') {
    if (!parsed.table || typeof parsed.table !== 'object') {
      flags.push('ask_missing_table');
    } else {
      if (!Array.isArray(parsed.table.columns)) flags.push('ask_table_no_columns');
      if (!Array.isArray(parsed.table.rows))    flags.push('ask_table_no_rows');
    }
  }

  if (task === 'compare_insight') {
    for (const k of ['summaryBullets', 'atAGlance', 'similarities', 'differences']) {
      if (!Array.isArray(parsed[k])) flags.push(`compare_missing_${k}`);
    }
    if (typeof parsed.mostDistinctContrast !== 'string') {
      flags.push('compare_missing_mostDistinctContrast');
    }
  } else {
    if (!Array.isArray(parsed.bullets)) flags.push('insight_missing_bullets');
  }

  return { ok: flags.length === 0, flags };
}
