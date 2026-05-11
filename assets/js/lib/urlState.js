/**
 * Team USA Atlas — URL hash state persistence
 *
 * Hash format: #/<view>?k1=v1&k2=v2
 *   - view is one of: atlas | sport | parity | compare | ask | methodology
 *   - params are flat key/value strings (URLSearchParams compatible)
 *
 * Empty / unrecognized hash → { view: null, params: {} }; the caller decides
 * the default view. Pure utility module — no DOM, no router coupling. The
 * router subscribes via onHashChange() once startHashListener() has wired the
 * window-level events.
 */

const VALID_VIEWS = new Set(['atlas', 'sport', 'parity', 'compare', 'ask', 'methodology']);

/**
 * Parse a hash string into { view, params }. Permissive: accepts '#/atlas?k=v',
 * '#atlas?k=v', '#/atlas', '#', and ''. Returns view=null if the segment is
 * missing or not in VALID_VIEWS. Never throws — falls back to {view:null,
 * params:{}} on any parsing failure.
 */
export function parseHash(hash = window.location.hash) {
  const fallback = { view: null, params: {} };
  try {
    if (typeof hash !== 'string' || hash.length === 0) return fallback;

    let s = hash;
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s.charAt(0) === '/') s = s.slice(1);
    if (s.length === 0) return fallback;

    const qIdx = s.indexOf('?');
    const viewPart = qIdx === -1 ? s : s.slice(0, qIdx);
    const queryPart = qIdx === -1 ? '' : s.slice(qIdx + 1);

    const view = VALID_VIEWS.has(viewPart) ? viewPart : null;

    const params = {};
    if (queryPart) {
      const sp = new URLSearchParams(queryPart);
      sp.forEach((value, key) => { params[key] = value; });
    }
    return { view, params };
  } catch (err) {
    console.warn('[urlState] parseHash failed', err);
    return fallback;
  }
}

/**
 * Build a hash string from a view + params object. Skips params whose value is
 * null, undefined, or ''. Keys are sorted alphabetically so the resulting URL
 * is deterministic (useful for de-duping writeHash calls and for shareable
 * links). Returns '' if view is falsy.
 */
export function buildHash(view, params = {}) {
  if (!view) return '';
  const base = `#/${view}`;
  if (!params || typeof params !== 'object') return base;

  const keys = Object.keys(params).filter((k) => {
    const v = params[k];
    return v !== null && v !== undefined && v !== '';
  }).sort();

  if (keys.length === 0) return base;

  const sp = new URLSearchParams();
  keys.forEach((k) => { sp.append(k, String(params[k])); });
  return `${base}?${sp.toString()}`;
}

/**
 * Replace the current history entry with a new hash. No-op if the resulting
 * hash equals window.location.hash (avoids spurious history churn while a view
 * is incrementally syncing its filters). Wrapped in try/catch — some embeds
 * (sandboxed iframes, file://) disallow the history API.
 */
export function writeHash(view, params = {}) {
  try {
    const next = buildHash(view, params);
    if (next === window.location.hash) return;
    window.history.replaceState(null, '', next || '#');
  } catch (err) {
    console.warn('[urlState] writeHash failed', err);
  }
}

/**
 * Push a new history entry. Used for navigation between views (so the back
 * button returns to the prior view) rather than per-filter state mutations.
 */
export function pushHash(view, params = {}) {
  try {
    const next = buildHash(view, params);
    if (next === window.location.hash) return;
    window.history.pushState(null, '', next || '#');
  } catch (err) {
    console.warn('[urlState] pushHash failed', err);
  }
}

const _listeners = new Set();
let _wired = false;

/**
 * Subscribe to hash changes. Handler is invoked with the parsed {view, params}
 * payload on every hashchange / popstate. Returns an unsubscribe function.
 */
export function onHashChange(handler) {
  if (typeof handler !== 'function') return () => {};
  _listeners.add(handler);
  return () => { _listeners.delete(handler); };
}

function _fire() {
  const parsed = parseHash();
  _listeners.forEach((fn) => {
    try { fn(parsed); }
    catch (err) { console.error('[urlState] listener threw', err); }
  });
}

/**
 * Wire window-level hashchange + popstate events so registered listeners fire.
 * Idempotent — safe to call multiple times; only the first call attaches the
 * underlying event listeners.
 */
export function startHashListener() {
  if (_wired) return;
  _wired = true;
  try {
    window.addEventListener('hashchange', _fire);
    window.addEventListener('popstate', _fire);
  } catch (err) {
    console.warn('[urlState] startHashListener failed', err);
  }
}
