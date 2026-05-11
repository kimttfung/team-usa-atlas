/**
 * Team USA Atlas — data loader
 *
 * Fetches all nine sources from /data/ in parallel and returns a single
 * store object the rest of the app reads from:
 *   - 7 cleaned aggregate files (athletes, athlete_sports, participation,
 *     state_summary, state_sport_summary, hometown_summary, climate)
 *   - us-states-map.json    (precomputed Albers projection of state polygons)
 *   - hometown_geo.json      (per-hometown pixel coordinates for map bubbles)
 *
 * No fallbacks, no synthetic data — if a file is missing or malformed we
 * throw a clear error that names the file, and main.js surfaces it to the UI.
 */

const DATA_FILES = [
  { key: 'athletes',          path: '/data/athletes_clean.json' },
  { key: 'athleteSports',     path: '/data/athlete_sports.json' },
  { key: 'participation',     path: '/data/athlete_participation_clean.json' },
  { key: 'stateSummary',      path: '/data/state_summary.json' },
  { key: 'stateSportSummary', path: '/data/state_sport_summary.json' },
  { key: 'hometownSummary',   path: '/data/hometown_summary.json' },
  { key: 'climate',           path: '/data/climate_state_summary.json' },
  { key: 'mapShapes',         path: '/data/us-states-map.json' },
  { key: 'hometownGeo',       path: '/data/hometown_geo.json' },
];

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`Failed to load ${path} — HTTP ${res.status} ${res.statusText}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`Failed to parse ${path} as JSON: ${err.message}`);
  }
}

function validateShape(key, value) {
  if (key === 'mapShapes') {
    if (!value || typeof value !== 'object' || !value.viewBox || !value.states) {
      throw new Error(`mapShapes JSON missing required keys (viewBox, states)`);
    }
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} JSON must be an array, got ${typeof value}`);
  }
  if (value.length === 0) {
    throw new Error(`${key} JSON is empty`);
  }
}

export async function loadAll() {
  const entries = await Promise.all(
    DATA_FILES.map(async ({ key, path }) => {
      const data = await fetchJson(path);
      validateShape(key, data);
      return [key, data];
    })
  );
  return Object.fromEntries(entries);
}
