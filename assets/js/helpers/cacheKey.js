/**
 * helpers/cacheKey.js
 *
 * Builds a stable, lowercase, pipe-delimited cache key from a view name and
 * a set of named inputs. Used to memoise compact view contexts produced by
 * `helpers/context.js` so future Gemini prompt payloads can be cached.
 *
 * Examples:
 *   makeContextCacheKey({ view: 'sport', sport: 'Swimming', program: 'both',
 *                         season: 'all', paraVariants: 'combined' })
 *     → 'sport|combined|both|all|swimming'
 *
 *   makeContextCacheKey({ view: 'atlas', metric: 'total_athletes',
 *                         program: 'both', season: 'all', sport: null })
 *     → 'atlas|total_athletes|both|all'
 *     (keys sorted alphabetically: metric, program, season; sport=null skipped)
 *
 *   makeContextCacheKey({ view: 'compare', a: 'CA', b: 'CO' })
 *     → 'compare|ca|co'
 *
 *   makeContextCacheKey({ view: 'parity', minAthletes: 30, viewMode: 'states' })
 *     → 'parity|30|states'
 *
 *   makeContextCacheKey({ view: 'ask', intent: 'top_states', entities: ['CA','CO'] })
 *     → 'ask|ca,co|top_states'
 */

function encodeValue(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.toLowerCase() : String(v)))
      .slice()
      .sort()
      .join(',');
  }
  throw new Error(`makeContextCacheKey: value for "${key}" is an unsupported object/type. Only strings, numbers, booleans, arrays, or null are allowed.`);
}

/**
 * @param {{ view: string } & Record<string, unknown>} input
 * @returns {string}
 */
export function makeContextCacheKey({ view, ...rest } = {}) {
  if (typeof view !== 'string' || view.trim() === '') {
    throw new Error('makeContextCacheKey: `view` is required and must be a non-empty string.');
  }
  const sortedKeys = Object.keys(rest).sort();
  const parts = [view.toLowerCase()];
  for (const k of sortedKeys) {
    const encoded = encodeValue(k, rest[k]);
    if (encoded === null || encoded === '') continue;
    parts.push(encoded);
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Self-tests (NOT auto-invoked). Call __test() from a console to verify.
// ---------------------------------------------------------------------------
export function __test() {
  const cases = [
    [
      { view: 'sport', sport: 'Swimming', program: 'both', season: 'all', paraVariants: 'combined' },
      'sport|combined|both|all|swimming',
    ],
    [
      { view: 'atlas', metric: 'total_athletes', program: 'both', season: 'all', sport: null },
      'atlas|total_athletes|both|all',
    ],
    [
      { view: 'compare', a: 'CA', b: 'CO' },
      'compare|ca|co',
    ],
    [
      { view: 'parity', minAthletes: 30, viewMode: 'states', season: null },
      'parity|30|states',
    ],
    [
      { view: 'ask', intent: 'top_states', entities: ['CO', 'CA'] },
      'ask|ca,co|top_states',
    ],
  ];
  for (const [input, expected] of cases) {
    const got = makeContextCacheKey(input);
    if (got !== expected) {
      throw new Error(`cacheKey test failed: got "${got}" expected "${expected}" for ${JSON.stringify(input)}`);
    }
  }
  return true;
}
