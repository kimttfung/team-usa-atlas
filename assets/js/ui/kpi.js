/**
 * ui/kpi.js — small render helpers for KPI tiles & split bars
 *
 * Pages own the surrounding card markup; these helpers fill known DOM ids
 * with freshly formatted values. Keep zero-knowledge of any specific page.
 */

export function fmtInt(n) {
  const num = Number(n);
  if (n == null || !Number.isFinite(num)) return '—';
  return num.toLocaleString();
}

export function fmtPct(ratio, digits = 1) {
  const num = Number(ratio);
  if (ratio == null || !Number.isFinite(num)) return '—';
  return `${(num * 100).toFixed(digits)}%`;
}

export function fmtRatio(value, digits = 3) {
  const num = Number(value);
  if (value == null || !Number.isFinite(num)) return '—';
  return num.toFixed(digits);
}

/**
 * Set the textContent of a DOM id if it exists. Silent no-op otherwise.
 */
export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/**
 * Render a horizontal split bar into hostEl with two labelled segments.
 * leftValue / rightValue are integer counts; widths scale to 100%.
 *
 * <div class="split-bar"><span class="left" style="--w:55%"></span>
 *                       <span class="right" style="--w:45%"></span></div>
 */
export function renderSplitBar(hostEl, { leftValue, rightValue, leftLabel, rightLabel }) {
  if (!hostEl) return;
  const total = (leftValue || 0) + (rightValue || 0);
  const lw = total ? (leftValue / total) * 100 : 0;
  const rw = total ? (rightValue / total) * 100 : 0;
  hostEl.innerHTML = `
    <div class="split-bar" role="img" aria-label="${leftLabel} vs ${rightLabel}">
      <span class="seg seg-left"  style="width:${lw.toFixed(1)}%"></span>
      <span class="seg seg-right" style="width:${rw.toFixed(1)}%"></span>
    </div>
    <div class="split-bar-legend">
      <span><b>${leftLabel}</b> ${fmtInt(leftValue)} (${fmtPct(total ? leftValue / total : 0, 0)})</span>
      <span><b>${rightLabel}</b> ${fmtInt(rightValue)} (${fmtPct(total ? rightValue / total : 0, 0)})</span>
    </div>
  `;
}

/**
 * Render a list of ranked rows into hostEl. Each row is { label, value, sub? }.
 */
export function renderRankedList(hostEl, items, { format = fmtInt, emptyMessage = 'No data.' } = {}) {
  if (!hostEl) return;
  if (!items || items.length === 0) {
    hostEl.innerHTML = `<div class="ranked-empty">${emptyMessage}</div>`;
    return;
  }
  const max = Math.max(...items.map((it) => it.value || 0));
  hostEl.innerHTML = items.map((it, i) => {
    const pct = max ? ((it.value || 0) / max) * 100 : 0;
    return `
      <div class="ranked-row" style="--i:${i}">
        <span class="ranked-label">${it.label}${it.sub ? `<span class="ranked-sub"> · ${it.sub}</span>` : ''}</span>
        <span class="ranked-bar"><span style="width:${pct.toFixed(1)}%"></span></span>
        <span class="ranked-value">${format(it.value)}</span>
      </div>
    `;
  }).join('');
}
