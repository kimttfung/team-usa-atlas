/**
 * Team USA Atlas — boot entry
 *
 * 1. Show a lightweight loading state on #appLoader while data fetches.
 * 2. Await initStore() which loads all nine JSON sources from /data/.
 * 3. On error, render a clear message naming the failure (no fake fallback).
 * 4. On success: hide loader, init theme, register page modules with router,
 *    then start the router on the default view (atlas).
 *
 * Page modules are imported for side-effects: each one registers itself with
 * the router via registerView(name, onEnter).
 */

import { initStore } from './data/store.js';
import { initRouter } from './lib/router.js';
import { initTheme } from './lib/theme.js';
import {
  getAtlasContext,
  getSportContext,
  getParityContext,
  getCompareContext,
  getAskContext,
} from './helpers/context.js';
import { makeContextCacheKey } from './helpers/cacheKey.js';

import './pages/atlas.js';
import './pages/sport.js';
import './pages/parity.js';
import './pages/compare.js';
import './pages/ask.js';
import './pages/methodology.js';

function showLoader() {
  const loader = document.getElementById('appLoader');
  if (loader) loader.dataset.state = 'loading';
}

function hideLoader() {
  const loader = document.getElementById('appLoader');
  if (loader) loader.dataset.state = 'ready';
}

function showFatalError(err) {
  const loader = document.getElementById('appLoader');
  if (!loader) {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<pre style="padding:24px;color:#b91c1c;font-family:ui-monospace,monospace;white-space:pre-wrap;">Team USA Atlas failed to load.\n\n${err.message}</pre>`
    );
    return;
  }
  loader.dataset.state = 'error';
  loader.innerHTML = `
    <div class="app-loader__inner">
      <h2>Team USA Atlas couldn't load.</h2>
      <p>${err.message}</p>
      <p class="app-loader__hint">Make sure you're running the app via <code>npm run dev</code> so all sources are reachable.</p>
    </div>
  `;
  console.error('[boot] fatal:', err);
}

async function boot() {
  showLoader();
  try {
    await initStore();
    initTheme();
    initRouter('atlas');
    hideLoader();
  } catch (err) {
    showFatalError(err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Dev-only: dump the compact view context that future Gemini prompts will use.
// Gated to localhost so the helper isn't exposed on production deploys; on a
// localhost dev server it's still callable from the browser console.
const __isLocalhost = typeof location !== 'undefined' && (
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname === '0.0.0.0' ||
  location.hostname === '' ||
  location.protocol === 'file:'
);
if (__isLocalhost) window.__atlasDebugContext = function __atlasDebugContext(view, opts) {
  const builders = {
    atlas: getAtlasContext,
    sport: getSportContext,
    parity: getParityContext,
    compare: getCompareContext,
    ask: getAskContext,
  };
  const builder = builders[view];
  if (!builder) {
    console.warn('[atlas debug context] unknown view:', view, '— expected one of:', Object.keys(builders).join(', '));
    return null;
  }
  const input = opts || {};
  const result = builder(input);

  // Build a cache key from the same inputs (best-effort — non-primitive
  // entities on the Ask view are skipped).
  let cacheKey = null;
  try {
    const keyInput = { view };
    if (view === 'atlas') {
      const f = input.filters || {};
      Object.assign(keyInput, {
        selectedState: input.selectedState || null,
        metric: f.metric || null,
        program: f.program || null,
        season: f.season || null,
        sport: f.sport || null,
      });
    } else if (view === 'sport') {
      const f = input.filters || {};
      Object.assign(keyInput, {
        sport: input.sport || null,
        program: f.program || null,
        season: f.season || null,
        paraVariants: f.paraVariants || null,
      });
    } else if (view === 'parity') {
      const f = input.filters || {};
      Object.assign(keyInput, {
        viewMode: f.viewMode || null,
        season: f.season || null,
        minAthletes: typeof f.minAthletes === 'number' ? f.minAthletes : null,
      });
    } else if (view === 'compare') {
      Object.assign(keyInput, {
        a: input.stateA || null,
        b: input.stateB || null,
      });
    } else if (view === 'ask') {
      Object.assign(keyInput, { intent: input.intent || null });
    }
    cacheKey = makeContextCacheKey(keyInput);
  } catch (err) {
    console.warn('[atlas debug context] could not build cache key:', err.message);
  }

  console.log('[atlas debug context]', view, '→ cacheKey:', cacheKey);
  console.dir(result, { depth: null });
  return result;
};
