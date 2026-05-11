/**
 * Team USA Atlas — view router
 *
 * Drives the active view by coordinating these DOM hooks:
 *  - flips data-view on the .app shell
 *  - sets data-active on each <section class="view">
 *  - manages aria-current on .nav-item buttons
 *  - updates the topbar title
 *  - wires nav-item clicks, [data-view-jump] buttons, and 1..6 / ⌘K shortcuts
 *
 * Page modules register an onEnter callback via registerView(name, fn) so the
 * router stays decoupled from page logic. The first time a view is entered the
 * onEnter callback is invoked; subsequent visits also re-invoke it (so per-view
 * animations and filter sync re-run on every navigation).
 */

const TITLES = {
  atlas: 'Atlas Overview',
  sport: 'Sport Explorer',
  parity: 'Parity Lens',
  compare: 'Compare Regions',
  ask: 'Ask the Analyst',
  methodology: 'Methodology',
};

const KEY_MAP = { '1': 'atlas', '2': 'sport', '3': 'parity', '4': 'compare', '5': 'ask', '6': 'methodology' };

import { parseHash, writeHash, pushHash, onHashChange, startHashListener } from './urlState.js';

const _handlers = new Map();
let _current = null;
let _pendingParams = null;
let _navigatingFromHash = false;

export function registerView(name, onEnter) {
  if (!TITLES[name]) {
    throw new Error(`registerView: unknown view "${name}"`);
  }
  _handlers.set(name, onEnter);
}

export function getCurrentView() {
  return _current;
}

/**
 * Pages call this from inside their onEnter handler to retrieve any params the
 * caller of setView passed in (e.g. a state code to preselect). Returns null
 * if nothing was queued; consuming clears them so a normal nav doesn't replay.
 */
export function consumeViewParams() {
  const p = _pendingParams;
  _pendingParams = null;
  return p;
}

export function setView(name, params = null) {
  if (!TITLES[name]) return;
  // Re-click guard: if the user clicks a nav button for the page they are
  // already on, bail out before the active-state writes + onEnter call.
  // Without this, every nav re-click re-ran the page's onEnter handler
  // which re-rendered the DOM and replayed all the cardPopIn entry
  // animations — so the cards would visibly bounce in again as if the
  // page had just been opened. Genuine same-view re-entries (e.g. a map
  // click that fires setView('atlas', {state:'CA'}), or a hash change
  // from back/forward navigation that passes __fromHash:true) always
  // include a non-null params object, so they fall through and re-render
  // as expected to reflect the new state.
  if (_current === name && params == null) return;
  const prev = _current;
  _current = name;
  _pendingParams = params;

  if (!_navigatingFromHash) {
    const hashParams = params || {};
    if (prev && prev !== name) {
      pushHash(name, hashParams);
    } else {
      writeHash(name, hashParams);
    }
  }

  const app = document.querySelector('.app');
  if (app) app.setAttribute('data-view', name);

  document.querySelectorAll('section.view').forEach((s) => {
    s.dataset.active = (s.dataset.view === name) ? 'true' : 'false';
  });

  document.querySelectorAll('#navMain .nav-item').forEach((btn) => {
    if (btn.dataset.view === name) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  const titleEl = document.getElementById('topTitle');
  if (titleEl) titleEl.textContent = TITLES[name];

  // Reset scroll to the top whenever the user navigates to a different
  // view. The topbar (.topbar), filterbar (.filterbar) and sidebar
  // (.sidebar) are all position:sticky/fixed against the viewport — they
  // stay in place when the window scrolls. Same-view re-entries (e.g.
  // map-click param updates that fire setView('atlas', {state:'CA'}))
  // intentionally do NOT scroll, so the user keeps their reading
  // position when filters change. `behavior: 'auto'` (instant) avoids
  // the smooth-scroll animation that feels laggy on mobile.
  if (prev !== name) {
    try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }
    catch { window.scrollTo(0, 0); }
  }

  const onEnter = _handlers.get(name);
  if (typeof onEnter === 'function') {
    try { onEnter(name); }
    catch (err) { console.error(`[router] onEnter "${name}" threw`, err); }
  }
}

/**
 * Merge partial params over the current hash params for the active view and
 * write them back via replaceState. Keys whose value is null/undefined/'' are
 * dropped so callers can clear individual params by passing them as null.
 */
export function updateUrlState(partialParams) {
  const view = getCurrentView();
  if (!view) return;
  const existing = parseHash().params || {};
  const merged = { ...existing };
  if (partialParams && typeof partialParams === 'object') {
    Object.keys(partialParams).forEach((k) => {
      const v = partialParams[k];
      if (v === null || v === undefined || v === '') {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    });
  }
  writeHash(view, merged);
}

export function initRouter(initialView = 'atlas') {
  // Disable browser-managed scroll restoration so the back/forward
  // buttons do not silently restore an old scroll offset and fight
  // our explicit "scroll to top on view change" logic in setView().
  if ('scrollRestoration' in window.history) {
    try { window.history.scrollRestoration = 'manual'; } catch { /* ignore */ }
  }

  document.querySelectorAll('#navMain .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  document.querySelectorAll('[data-view-jump]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.viewJump));
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (e.metaKey && e.key === 'k') {
      e.preventDefault();
      setView('ask');
      const askInput = document.getElementById('askInput');
      if (askInput) askInput.focus();
      return;
    }
    if (KEY_MAP[e.key]) setView(KEY_MAP[e.key]);
  });

  onHashChange((parsed) => {
    if (!parsed.view) return;
    _navigatingFromHash = true;
    try {
      // Re-dispatch every hashchange (including same-view param edits) so pages
      // can re-consume params and resync filters. updateUrlState uses
      // replaceState, which does not fire hashchange, so this won't loop.
      setView(parsed.view, { ...(parsed.params || {}), __fromHash: true });
    } finally {
      _navigatingFromHash = false;
    }
  });

  startHashListener();

  const initial = parseHash();
  if (initial.view) {
    _navigatingFromHash = true;
    try {
      setView(initial.view, { ...(initial.params || {}), __fromHash: true });
    } finally {
      _navigatingFromHash = false;
    }
  } else {
    setView(initialView);
  }
}
