/**
 * helpers/contextCache.js — small per-view LRU(ish) cache for context objects.
 *
 * Each view holds a `Map<string, any>` capped at 50 entries. On every read we
 * delete-then-set to bump recency; on insertion we evict the oldest.
 *
 * The cache is keyed by the string returned from `makeContextCacheKey(...)`.
 */

const MAX_ENTRIES = 50;
const _stores = new Map(); // view -> Map<key, value>

function storeFor(view) {
  let s = _stores.get(view);
  if (!s) { s = new Map(); _stores.set(view, s); }
  return s;
}

export function getCachedContext(view, key) {
  const s = storeFor(view);
  if (!s.has(key)) return null;
  const v = s.get(key);
  s.delete(key);
  s.set(key, v);
  return v;
}

export function setCachedContext(view, key, value) {
  const s = storeFor(view);
  if (s.has(key)) s.delete(key);
  s.set(key, value);
  while (s.size > MAX_ENTRIES) {
    const oldest = s.keys().next().value;
    s.delete(oldest);
  }
  return value;
}

/**
 * Convenience: read-through getter.
 *
 * @template T
 * @param {string} view
 * @param {string} key
 * @param {() => T} build
 * @returns {T}
 */
export function getOrBuildContext(view, key, build) {
  const hit = getCachedContext(view, key);
  if (hit) return hit;
  const fresh = build();
  setCachedContext(view, key, fresh);
  return fresh;
}
