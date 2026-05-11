/**
 * ui/map.js — choropleth U.S. state map renderer
 *
 * Mounts an SVG into the given host element using the precomputed paths from
 * us-states-map.json (loaded into the store under .mapShapes). Colors each
 * state into one of 6 heat tiers (.heat-0 … .heat-5) based on the supplied
 * { stateCode → value } map. Idempotent: calling renderMap again on the same
 * host re-mounts cleanly (used when filters change).
 *
 * Tooltip targets the shared #tooltip element if present, otherwise inlined.
 */

import { getStore, STATE_NAMES } from '../data/store.js';

const HEAT_TIERS = 6; // .heat-0 .. .heat-5
const NS = 'http://www.w3.org/2000/svg';

function tierFor(value, max, ranks) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Quantile-rank scale: distributes states across the 6 tiers based on their
  // rank percentile rather than linear value-vs-max. This prevents one outlier
  // (e.g. California in Total Athletes) from collapsing every other state into
  // the lightest bin.
  if (ranks && ranks.totalNonZero > 0) {
    const rank = ranks.rankByValue.get(value);
    if (rank == null) return 0;
    const pct = rank / ranks.totalNonZero;
    return Math.min(HEAT_TIERS - 1, Math.max(0, Math.floor(pct * HEAT_TIERS)));
  }
  if (max <= 0) return 0;
  const ratio = value / max;
  return Math.min(HEAT_TIERS - 1, Math.max(0, Math.floor(ratio * HEAT_TIERS)));
}

/**
 * Build a value→rank lookup over the non-zero finite values, sorted ascending.
 * Returns { rankByValue: Map, totalNonZero: number }. Tied values share their
 * highest rank within the tied run so the choropleth color stays stable for ties.
 */
function buildRanks(valueByState) {
  const values = Object.values(valueByState).filter((v) => Number.isFinite(v) && v > 0);
  const sorted = values.slice().sort((a, b) => a - b);
  const rankByValue = new Map();
  let prev = null;
  let rank = 0;
  sorted.forEach((v, i) => {
    if (v !== prev) rank = i + 1;
    rankByValue.set(v, rank);
    prev = v;
  });
  return { rankByValue, totalNonZero: sorted.length };
}

function findTooltipEl() {
  return document.getElementById('tooltip');
}

function showTooltip(el, html, evt) {
  if (!el) return;
  el.innerHTML = html;
  el.dataset.show = 'true';
  positionTooltip(el, evt);
}
function hideTooltip(el) {
  if (!el) return;
  el.dataset.show = 'false';
}
function positionTooltip(el, evt) {
  if (!el || !evt) return;
  const x = evt.clientX + 14;
  const y = evt.clientY + 14;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

/**
 * @param {string} hostId  DOM id to mount the SVG into.
 * @param {object} options
 *   - valueByState: { [code]: number }
 *   - metricLabel: string (shown in tooltip)
 *   - format: (value) => string (default: integer with commas, '—' for null)
 *   - selected: state code currently highlighted
 *   - onSelect: (state) => void
 *   - onHover:  (state, value) => void
 */
export function renderMap(hostId, options = {}) {
  const host = document.getElementById(hostId);
  if (!host) return;

  const { mapShapes } = getStore();
  if (!mapShapes || !mapShapes.states) return;

  const valueByState = options.valueByState || {};
  const metricLabel  = options.metricLabel || 'Athletes';
  const format       = options.format || ((v) => v == null ? '—' : Number(v).toLocaleString());
  const onSelect     = options.onSelect;
  const onHover      = options.onHover;

  const max = Math.max(0, ...Object.values(valueByState).filter((v) => Number.isFinite(v)));
  const ranks = buildRanks(valueByState);

  // Wipe + remount
  host.innerHTML = '';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', mapShapes.viewBox);
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'U.S. state map');

  const tipEl = findTooltipEl();

  for (const [code, shape] of Object.entries(mapShapes.states)) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', shape.d);
    const value = valueByState[code];
    const tier  = tierFor(value, max, ranks);
    path.setAttribute('class', `map-state heat-${tier}`);
    path.dataset.st = code;
    path.dataset.selected = (options.selected === code) ? 'true' : 'false';
    const stateName = STATE_NAMES[code] || shape.name || code;
    path.setAttribute('role', 'img');
    path.setAttribute('aria-label', `${stateName}, ${format(value)} ${metricLabel}`);

    path.addEventListener('mouseenter', (evt) => {
      const name = STATE_NAMES[code] || shape.name || code;
      const valueStr = format(value);
      const html = `<strong>${name}</strong><div class="row"><span class="k">${metricLabel}</span><span class="v">${valueStr}</span></div>`;
      showTooltip(tipEl, html, evt);
      if (onHover) onHover(code, value);
    });
    path.addEventListener('mousemove', (evt) => positionTooltip(tipEl, evt));
    path.addEventListener('mouseleave', () => hideTooltip(tipEl));
    if (typeof onSelect === 'function') {
      path.addEventListener('click', () => onSelect(code));
    }

    svg.appendChild(path);
  }

  // Bubble overlay: optional top-N hometown circles, sized by athlete count
  // (sqrt scale to keep area proportional). Each bubble carries a tooltip
  // showing city + count. Coordinates are in the same SVG viewport as state
  // paths (precomputed in data/hometown_geo.json).
  if (Array.isArray(options.bubbles) && options.bubbles.length) {
    renderBubbles(svg, options.bubbles, tipEl, options.bubbleLabel || 'Athletes');
  }

  host.appendChild(svg);
  return svg;
}

function renderBubbles(svg, bubbles, tipEl, label) {
  // Drop any prior bubble layer (idempotency in case caller mutates the SVG)
  svg.querySelectorAll('g.map-bubbles').forEach((g) => g.remove());
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'map-bubbles');
  g.setAttribute('pointer-events', 'auto');

  const maxV = Math.max(1, ...bubbles.map((b) => b.total_athletes || 0));
  const MIN_R = 4;
  const MAX_R = 22;

  // Sort largest-first so smaller bubbles render on top (clickable)
  const sorted = bubbles.slice().sort((a, b) => (b.total_athletes || 0) - (a.total_athletes || 0));
  for (const b of sorted) {
    const v = Math.max(0, Number(b.total_athletes) || 0);
    const r = MIN_R + (MAX_R - MIN_R) * Math.sqrt(v / maxV);
    // Hubs that have hosted both Olympic and Paralympic athletes get a teal
    // outline + teal ripple ring so they read as dual-program at a glance.
    const olyN  = Number(b.olympic_athletes)  || 0;
    const paraN = Number(b.paralympic_athletes) || 0;
    const hasPara = olyN > 0 && paraN > 0;
    const paraCls = hasPara ? ' has-para' : '';

    // Group wraps: two ripple rings (continuous radar pulse, staggered) +
    // the solid dot. The CSS animation `cityRipple` on `.city-ripple` scales
    // each ring from 0.92 → 2.6 over 2.6s, giving every hub bubble the same
    // breathing life as the existing legend bubbles.
    const grp = document.createElementNS(NS, 'g');
    grp.setAttribute('class', `city-bubble${paraCls}`);
    grp.dataset.city = `${b.hometown_city}, ${b.hometown_state}`;
    grp.dataset.count = String(v);

    const ripple1 = document.createElementNS(NS, 'circle');
    ripple1.setAttribute('cx', b.x);
    ripple1.setAttribute('cy', b.y);
    ripple1.setAttribute('r', r.toFixed(1));
    ripple1.setAttribute('class', `city-ripple${paraCls}`);
    grp.appendChild(ripple1);

    const ripple2 = document.createElementNS(NS, 'circle');
    ripple2.setAttribute('cx', b.x);
    ripple2.setAttribute('cy', b.y);
    ripple2.setAttribute('r', r.toFixed(1));
    ripple2.setAttribute('class', `city-ripple city-ripple--2${paraCls}`);
    grp.appendChild(ripple2);

    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', b.x);
    dot.setAttribute('cy', b.y);
    dot.setAttribute('r', r.toFixed(1));
    dot.setAttribute('class', `city-dot${paraCls}`);
    grp.appendChild(dot);

    // Tooltip + hover handlers attach to the group so the whole bubble (dot +
    // ripples) is interactive. `.city-ripple` carries `pointer-events: none`
    // in CSS so flicker from the rippling rings can't toggle the tooltip.
    grp.addEventListener('mouseenter', (evt) => {
      const html = `<strong>${b.hometown_city}, ${b.hometown_state}</strong>`
        + `<div class="row"><span class="k">${label}</span><span class="v">${v.toLocaleString()}</span></div>`
        + (hasPara ? `<div class="row"><span class="k">Mix</span><span class="v">Olympic + Paralympic</span></div>` : '');
      showTooltip(tipEl, html, evt);
    });
    grp.addEventListener('mousemove', (evt) => positionTooltip(tipEl, evt));
    grp.addEventListener('mouseleave', () => hideTooltip(tipEl));

    g.appendChild(grp);
  }
  svg.appendChild(g);
}

/**
 * Update colors + selection on an already-mounted map without rebuilding the SVG.
 * Cheaper than renderMap when only filter values change.
 */
export function updateMap(hostId, options = {}) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const svg = host.querySelector('svg');
  if (!svg) return renderMap(hostId, options);

  const valueByState = options.valueByState || {};
  const max = Math.max(0, ...Object.values(valueByState).filter((v) => Number.isFinite(v)));
  const ranks = buildRanks(valueByState);

  svg.querySelectorAll('.map-state').forEach((path) => {
    const code = path.dataset.st;
    const value = valueByState[code];
    const tier  = tierFor(value, max, ranks);
    path.setAttribute('class', `map-state heat-${tier}`);
    if (options.selected !== undefined) {
      path.dataset.selected = (options.selected === code) ? 'true' : 'false';
    }
  });
}

/**
 * Render the legend ramp (6 swatches) into the given host id.
 *
 * Optional opts:
 *   - min, max: numeric endpoints to label the ramp (e.g. 0 → 4,142)
 *   - format:   formatter for min/max labels (default: integer with commas)
 */
export function renderLegendRamp(hostId, varBase = 'ramp', opts = {}) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const { min, max, format } = opts;
  const fmt = typeof format === 'function'
    ? format
    : (v) => v == null ? '—' : Number(v).toLocaleString();
  host.innerHTML = '';

  const showLabels = Number.isFinite(min) && Number.isFinite(max);
  if (showLabels) {
    const minLbl = document.createElement('span');
    minLbl.className = 'legend-label legend-label--min';
    minLbl.textContent = fmt(min);
    host.appendChild(minLbl);
  }
  for (let i = 0; i < HEAT_TIERS; i += 1) {
    const sw = document.createElement('span');
    sw.className = `legend-swatch`;
    sw.style.background = `var(--${varBase}-${i})`;
    host.appendChild(sw);
  }
  if (showLabels) {
    const maxLbl = document.createElement('span');
    maxLbl.className = 'legend-label legend-label--max';
    maxLbl.textContent = fmt(max);
    host.appendChild(maxLbl);
  }
}
