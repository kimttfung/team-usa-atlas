/**
 * ui/miniCharts.js — 12-month temperature & precipitation mini-charts
 *
 * Plain SVG; no chart library. Reads month columns from a climate row
 * (climate_state_summary schema). Both renderers are idempotent.
 *
 * Each chart includes:
 *   - top + bottom grid lines anchoring the plot area
 *   - y-axis numeric labels (max + min) on the right edge of the SVG
 *   - quarterly x-axis month labels (Jan / Apr / Jul / Oct) inside the SVG,
 *     anchored to the same x positions as the underlying data points
 */

import { MONTHS } from '../data/store.js';

const NS = 'http://www.w3.org/2000/svg';

const W    = 240;
const H    = 96;
const padL = 6;
const padR = 30;
const padT = 10;
const padB = 18;
const plotW = W - padL - padR;
const plotH = H - padT - padB;

const QUARTER_INDICES = [0, 3, 6, 9];
const QUARTER_LABELS  = ['Jan', 'Apr', 'Jul', 'Oct'];

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function monthValues(climateRow, prefix) {
  return MONTHS.map((m) => {
    const v = climateRow?.[`${prefix}_${m}`];
    return Number.isFinite(v) ? Number(v) : null;
  });
}

function clearAndCreateSvg(host) {
  host.innerHTML = '';
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'mini-chart-svg',
    role: 'img',
  });
  host.appendChild(svg);
  return svg;
}

function addGridAndYAxis(svg, topLabel, bottomLabel) {
  // Grid lines
  svg.appendChild(svgEl('line', {
    x1: padL, x2: padL + plotW, y1: padT, y2: padT,
    class: 'mini-chart-grid',
  }));
  svg.appendChild(svgEl('line', {
    x1: padL, x2: padL + plotW, y1: padT + plotH, y2: padT + plotH,
    class: 'mini-chart-grid',
  }));

  // Y-axis numeric labels (top = max, bottom = min/zero)
  const tTop = svgEl('text', {
    x: padL + plotW + 3,
    y: padT + 3,
    class: 'mini-chart-axis',
    'text-anchor': 'start',
  });
  tTop.textContent = topLabel;
  svg.appendChild(tTop);

  const tBot = svgEl('text', {
    x: padL + plotW + 3,
    y: padT + plotH + 3,
    class: 'mini-chart-axis',
    'text-anchor': 'start',
  });
  tBot.textContent = bottomLabel;
  svg.appendChild(tBot);
}

function addXAxisLabels(svg) {
  QUARTER_INDICES.forEach((i, k) => {
    const x = padL + (plotW * (i / 11));
    const t = svgEl('text', {
      x: x.toFixed(1),
      y: padT + plotH + 12,
      class: 'mini-chart-axis mini-chart-axis--x',
      'text-anchor': 'middle',
    });
    t.textContent = QUARTER_LABELS[k];
    svg.appendChild(t);
  });
}

/**
 * Render a 12-month temperature line chart (°F) into hostEl.
 */
export function renderTempChart(host, climateRow) {
  if (typeof host === 'string') host = document.getElementById(host);
  if (!host) return;
  if (!climateRow) { host.innerHTML = '<div class="mini-chart-empty">No climate data.</div>'; return; }

  const values = monthValues(climateRow, 'monthly_temp');
  const present = values.filter((v) => v != null);
  if (present.length === 0) { host.innerHTML = '<div class="mini-chart-empty">No temperature data.</div>'; return; }

  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min || 1;

  const svg = clearAndCreateSvg(host);
  addGridAndYAxis(svg, `${Math.round(max)}°`, `${Math.round(min)}°`);

  const points = values.map((v, i) => {
    const x = padL + (plotW * (i / (values.length - 1)));
    const y = v == null ? null : padT + (plotH * (1 - (v - min) / range));
    return { x, y, v };
  });

  // Connected segments (skip null gaps)
  const segments = [];
  let cur = [];
  for (const p of points) {
    if (p.y == null) { if (cur.length) segments.push(cur); cur = []; }
    else cur.push(p);
  }
  if (cur.length) segments.push(cur);

  for (const seg of segments) {
    if (seg.length < 2) continue;
    const path = svgEl('path', {
      d: seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),
      class: 'mini-chart-line--warm',
    });
    svg.appendChild(path);
  }

  // Dots
  for (const p of points) {
    if (p.y == null) continue;
    svg.appendChild(svgEl('circle', {
      cx: p.x.toFixed(2),
      cy: p.y.toFixed(2),
      r: '1.8',
      class: 'mini-chart-dot--warm',
    }));
  }

  addXAxisLabels(svg);
}

/**
 * Render a 12-month precipitation bar chart (inches) into hostEl.
 */
export function renderPrecipChart(host, climateRow) {
  if (typeof host === 'string') host = document.getElementById(host);
  if (!host) return;
  if (!climateRow) { host.innerHTML = '<div class="mini-chart-empty">No climate data.</div>'; return; }

  const values = monthValues(climateRow, 'monthly_precip');
  const present = values.filter((v) => v != null);
  if (present.length === 0) { host.innerHTML = '<div class="mini-chart-empty">No precipitation data.</div>'; return; }

  const max = Math.max(...present, 0);
  const slot = plotW / values.length;
  const barW = Math.max(2, slot - 2);

  const svg = clearAndCreateSvg(host);
  addGridAndYAxis(svg, `${max.toFixed(1)}″`, '0″');

  values.forEach((v, i) => {
    const x = padL + slot * i + (slot - barW) / 2;
    const h = v == null || max === 0 ? 0 : (plotH * (v / max));
    const y = padT + plotH - h;
    svg.appendChild(svgEl('rect', {
      x: x.toFixed(2),
      y: y.toFixed(2),
      width: barW.toFixed(2),
      height: Math.max(0, h).toFixed(2),
      rx: '1.5',
      class: v == null ? 'mini-chart-bar--null' : 'mini-chart-bar--cool',
    }));
  });

  addXAxisLabels(svg);
}
