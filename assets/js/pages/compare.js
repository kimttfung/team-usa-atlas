/**
 * pages/compare.js — Compare Regions (states only in v1)
 *
 * #cmpSelectA / #cmpSelectB — state pickers
 * #cmpSwatchA / #cmpSwatchB — 2-letter code chips
 * #cmpTotalA / #cmpTotalB — quick total-athletes counters
 * #compareRows — full comparison table
 * #cmpInsightBody / #cmpInsightFollow — Comparison Insight (locally computed)
 *
 * Climate mini-charts are appended into compareRows for the climate row.
 */

import { registerView, consumeViewParams, updateUrlState } from '../lib/router.js';
import { getStore, STATE_NAMES } from '../data/store.js';
import { getStateOptions } from '../helpers/states.js';
import { compareStates, computeProfileLabels } from '../helpers/compare.js';
import { renderTempChart, renderPrecipChart } from '../ui/miniCharts.js';
import { fmtInt, fmtPct, fmtRatio } from '../ui/kpi.js';
import { attachCopyButton, htmlToPlainText } from '../ui/copyButton.js';
import { getCompareContext } from '../helpers/context.js';
import { makeContextCacheKey } from '../helpers/cacheKey.js';
import { makeCompareBrief } from '../helpers/responseSchemas.js';
import { getOrBuildContext } from '../helpers/contextCache.js';
import { generateInsight } from '../lib/gemini.js';
import { renderInsightSkeleton } from '../ui/insightSkeleton.js';
import { revealWords } from '../ui/typewriter.js';

const EMPTY_COMPARE_PAIRS = [
  { a: 'CA', b: 'CO', label: 'California ↔ Colorado' },
  { a: 'FL', b: 'TX', label: 'Florida ↔ Texas' },
  { a: 'NY', b: 'OH', label: 'New York ↔ Ohio' },
  { a: 'MN', b: 'AZ', label: 'Minnesota ↔ Arizona' },
];

const _state = { a: null, b: null };
let _initialised = false;

// Drop "off-map" entries (e.g. VI has no SVG path so the user can't compare it
// visually anyway). Keep DC because it has a map shape.
const COMPARE_EXCLUDE = new Set(['VI']);

function compareOptions() {
  return getStateOptions().filter((o) => !COMPARE_EXCLUDE.has(o.st));
}

function populateSelects() {
  const opts = compareOptions();
  const a = document.getElementById('cmpSelectA');
  const b = document.getElementById('cmpSelectB');
  const placeholder = '<option value="">— pick a state —</option>';
  const optionMarkup = opts.map((o) => `<option value="${o.st}">${o.name}</option>`).join('');
  if (a) a.innerHTML = placeholder + optionMarkup;
  if (b) b.innerHTML = placeholder + optionMarkup;
  syncSelectGuards();
  if (a) a.value = _state.a || '';
  if (b) b.value = _state.b || '';
}

// Disable the option matching the OTHER selector so the user can never pick the
// same state for both columns (the prior silent-swap was confusing). The empty
// placeholder option is never disabled — it represents "no selection yet".
function syncSelectGuards() {
  const a = document.getElementById('cmpSelectA');
  const b = document.getElementById('cmpSelectB');
  if (a) Array.from(a.options).forEach((o) => { o.disabled = (o.value !== '' && o.value === _state.b); });
  if (b) Array.from(b.options).forEach((o) => { o.disabled = (o.value !== '' && o.value === _state.a); });
}

function leadClass(va, vb) {
  if (va == null && vb == null) return ['', ''];
  if (va == null) return ['', 'lead'];
  if (vb == null) return ['lead', ''];
  if (va > vb) return ['lead', ''];
  if (vb > va) return ['', 'lead'];
  return ['', ''];
}

function metricRow(label, va, vb, format = fmtInt, sub) {
  const [la, lb] = leadClass(va, vb);
  const total = (va || 0) + (vb || 0);
  // When both sides are zero we want empty bars, not a misleading 50/50 placeholder.
  const ap = total ? ((va || 0) / total) * 100 : 0;
  const bp = total ? ((vb || 0) / total) * 100 : 0;
  return `
    <div class="compare-row">
      <div class="v left ${la}">${format(va)}${sub ? `<small>${sub}</small>` : ''}</div>
      <div class="k">
        ${label}
        <div class="bar"><i class="l" style="width:${ap.toFixed(1)}%"></i><i class="r" style="width:${bp.toFixed(1)}%"></i></div>
      </div>
      <div class="v right ${lb}">${format(vb)}${sub ? `<small>${sub}</small>` : ''}</div>
    </div>
  `;
}

function topListRow(label, listA, listB, mapper) {
  const renderList = (rows) => rows && rows.length
    ? rows.slice(0, 3).map((r) => `<div style="font-size:12px;color:var(--muted);font-family:var(--font-body);font-weight:500;line-height:1.6;">${mapper(r)}</div>`).join('')
    : '<small>—</small>';
  return `
    <div class="compare-row">
      <div class="v left" style="font-size:14px;font-weight:500;">${renderList(listA)}</div>
      <div class="k">${label}</div>
      <div class="v right" style="font-size:14px;font-weight:500;">${renderList(listB)}</div>
    </div>
  `;
}

function concentrationRow(va, vb) {
  const [la, lb] = leadClass(va, vb);
  const total = (va || 0) + (vb || 0);
  const ap = total ? ((va || 0) / total) * 100 : 0;
  const bp = total ? ((vb || 0) / total) * 100 : 0;
  const fmt = (v) => (v == null ? '—' : `Top 3 hubs: ${Math.round(v * 100)}%`);
  return `
    <div class="compare-row compare-row--concentration">
      <div class="v left ${la}">${fmt(va)}</div>
      <div class="k">
        Hometown Concentration
        <div class="bar"><i class="l" style="width:${ap.toFixed(1)}%"></i><i class="r" style="width:${bp.toFixed(1)}%"></i></div>
        <div class="cmp-row-caption">A higher top-hub share means the visible hometown pattern is more concentrated in a few listed hubs.</div>
      </div>
      <div class="v right ${lb}">${fmt(vb)}</div>
    </div>
  `;
}

function climateRow(label, va, vb, fmt) {
  const [la, lb] = leadClass(va, vb);
  return `
    <div class="compare-row">
      <div class="v left ${la}">${va == null ? '—' : fmt(va)}</div>
      <div class="k">${label}</div>
      <div class="v right ${lb}">${vb == null ? '—' : fmt(vb)}</div>
    </div>
  `;
}

function climateChartsRow(climateA, climateB, prefix, label) {
  return `
    <div class="compare-row" style="display:grid;grid-template-columns:1fr 130px 1fr;align-items:center;">
      <div class="v left" style="font-size:12px;font-weight:500;color:var(--muted);"><div id="cmpChart${prefix}A"></div></div>
      <div class="k">${label}</div>
      <div class="v right" style="font-size:12px;font-weight:500;color:var(--muted);"><div id="cmpChart${prefix}B"></div></div>
    </div>
  `;
}

function renderTable(cmp) {
  const host = document.getElementById('compareRows');
  if (!host) return;
  const ka = cmp.kpis.a;
  const kb = cmp.kpis.b;
  const cl = cmp.climate;

  host.innerHTML = [
    metricRow('Total Athletes',       ka.total_athletes,       kb.total_athletes),
    metricRow('Olympic Athletes',     ka.olympic_athletes,     kb.olympic_athletes),
    metricRow('Paralympic Athletes',  ka.paralympic_athletes,  kb.paralympic_athletes),
    metricRow('Summer Athletes',      ka.summer_athletes,      kb.summer_athletes),
    metricRow('Winter Athletes',      ka.winter_athletes,      kb.winter_athletes),
    metricRow('Sport Diversity',      ka.sport_count,          kb.sport_count),
    metricRow('Paralympic Share',     ka.paralympic_share,     kb.paralympic_share, (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`),
    metricRow('Balance Index',        ka.balance_index,        kb.balance_index, (v) => v == null ? '—' : v.toFixed(2)),
    metricRow('Share of National',    ka.share,                kb.share,        (v) => v == null ? '—' : `${(v * 100).toFixed(2)}%`),
    topListRow('Top Sports', cmp.topSports.a, cmp.topSports.b, (r) => `${r.sport} <small style="color:var(--muted-2);">${fmtInt(r.athlete_count)}</small>`),
    topListRow('Top Hometown Hubs', cmp.topHubs.a, cmp.topHubs.b, (r) => `${r.hometown_city}, ${r.hometown_state} <small style="color:var(--muted-2);">${fmtInt(r.total_athletes)}</small>`),
    concentrationRow(cmp.hometownConcentration.a.top3Share, cmp.hometownConcentration.b.top3Share),
    climateRow('Avg Annual Temp',  cl.a?.avg_annual_temp_f,    cl.b?.avg_annual_temp_f,    (v) => `${v.toFixed(1)} °F`),
    climateRow('Annual Precip',    cl.a?.avg_annual_precip_in, cl.b?.avg_annual_precip_in, (v) => `${v.toFixed(1)} in`),
    climateChartsRow(cl.a, cl.b, 'Temp',   'Monthly Temp'),
    climateChartsRow(cl.a, cl.b, 'Precip', 'Monthly Precip'),
  ].join('');

  if (cl.a) {
    renderTempChart('cmpChartTempA',     cl.a);
    renderPrecipChart('cmpChartPrecipA', cl.a);
  } else {
    document.getElementById('cmpChartTempA').innerHTML   = '<div class="mini-chart-empty">No NOAA normals.</div>';
    document.getElementById('cmpChartPrecipA').innerHTML = '<div class="mini-chart-empty">No NOAA normals.</div>';
  }
  if (cl.b) {
    renderTempChart('cmpChartTempB',     cl.b);
    renderPrecipChart('cmpChartPrecipB', cl.b);
  } else {
    document.getElementById('cmpChartTempB').innerHTML   = '<div class="mini-chart-empty">No NOAA normals.</div>';
    document.getElementById('cmpChartPrecipB').innerHTML = '<div class="mini-chart-empty">No NOAA normals.</div>';
  }
}

// Token bumped on each renderInsight call so a stale Gemini response from
// a prior state pair can't overwrite the current view.
let _compareInsightToken = 0;

function setCompareInsightBadge(kind, label) {
  const body = document.getElementById('cmpInsightBody');
  const card = body?.closest('.gemini');
  const head = card?.querySelector('.gemini__head');
  if (!head) return;
  let badge = head.querySelector('.gemini__source');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'gemini__source';
    head.appendChild(badge);
  }
  badge.dataset.kind = kind;
  badge.textContent = label;
}

function clearCompareInsightBadge() {
  const body = document.getElementById('cmpInsightBody');
  const card = body?.closest('.gemini');
  const badge = card?.querySelector('.gemini__head .gemini__source');
  if (badge) badge.remove();
}

function renderGeminiCompareInsight(result, body) {
  const sims  = Array.isArray(result?.similarities) ? result.similarities.filter(Boolean) : [];
  const diffs = Array.isArray(result?.differences)  ? result.differences.filter(Boolean)  : [];
  const glance = Array.isArray(result?.atAGlance)   ? result.atAGlance.filter(Boolean)    : [];
  const summary = Array.isArray(result?.summaryBullets) ? result.summaryBullets.filter(Boolean) : [];
  const sections = [
    summary.length ? {
      h: result?.title || 'Comparison Insight',
      p: `<ul class="cmp-insight-list">${summary.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`,
    } : null,
    glance.length ? {
      h: 'At a Glance',
      p: `<ul class="cmp-insight-list">${glance.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`,
    } : null,
    {
      h: "Where They're Alike",
      p: sims.length
        ? `<ul class="cmp-insight-list">${sims.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
        : '<span class="cmp-empty">No notable similarities above thresholds.</span>',
    },
    {
      h: 'Where They Differ',
      p: diffs.length
        ? `<ul class="cmp-insight-list">${diffs.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
        : '<span class="cmp-empty">No large differences above thresholds.</span>',
    },
    result?.mostDistinctContrast ? {
      h: 'Most Distinct Contrast',
      p: escapeHtml(result.mostDistinctContrast),
    } : null,
  ].filter(Boolean);
  body.innerHTML = sections.map((s) => `<div class="gemini__section"><h4>${s.h}</h4><p>${s.p}</p></div>`).join('');
  // Word-by-word reveal — same animation as the local fallback path so
  // the user can't tell the two apart by motion alone.
  revealWords(body);
}

function renderInsight(cmp) {
  const body = document.getElementById('cmpInsightBody');
  const follow = document.getElementById('cmpInsightFollow');
  if (!body) return;
  const nameA = STATE_NAMES[_state.a] || _state.a;
  const nameB = STATE_NAMES[_state.b] || _state.b;

  // Build the deterministic write-up lazily; only paint it if Gemini fails.
  // "At a Glance" / "Where They're Alike" / "Where They Differ" used to
  // render as separate cards in the LEFT column. They were consolidated
  // into the Comparison Insight panel so the page reads as a single
  // narrative — top-level summary first, glance bullets, then the
  // similarity / difference / most-distinct breakouts.
  const buildLocal = () => {
    const glance = Array.isArray(cmp.atAGlance) ? cmp.atAGlance.filter(Boolean) : [];
    const sims   = Array.isArray(cmp.similarities) ? cmp.similarities.filter(Boolean) : [];
    const diffs  = Array.isArray(cmp.differences)  ? cmp.differences.filter(Boolean)  : [];
    return [
      {
        h: `${nameA} vs ${nameB}`,
        p: `<ul class="cmp-insight-list">${cmp.summaryBullets.map((b) => `<li>${b}</li>`).join('')}</ul>`,
      },
      glance.length ? {
        h: 'At a Glance',
        p: `<ul class="cmp-insight-list">${glance.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`,
      } : null,
      {
        h: "Where They're Alike",
        p: sims.length
          ? `<ul class="cmp-insight-list">${sims.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
          : '<span class="cmp-empty">No notable similarities above thresholds.</span>',
      },
      {
        h: 'Where They Differ',
        p: diffs.length
          ? `<ul class="cmp-insight-list">${diffs.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
          : '<span class="cmp-empty">No large differences above thresholds.</span>',
      },
      cmp.mostDistinctContrast ? {
        h: 'Most Distinct Contrast',
        p: escapeHtml(cmp.mostDistinctContrast),
      } : null,
    ].filter(Boolean);
  };

  // 1. Skeleton + Loading badge first.
  renderInsightSkeleton(body);
  setCompareInsightBadge('loading', 'Gemini reading…');
  if (follow) {
    follow.innerHTML = `
      <button type="button" class="followup-chip" data-swap="ab">Swap A ↔ B</button>
      <button type="button" class="followup-chip" data-pair="CA,TX">CA vs TX</button>
      <button type="button" class="followup-chip" data-pair="NY,FL">NY vs FL</button>
      <button type="button" class="followup-chip" data-pair="MN,WI">MN vs WI</button>
    `;
  }

  // 2. Try Gemini. On success render its answer; on failure render the
  //    deterministic write-up. Either way attach a fresh copy button at
  //    the end so the clipboard always reflects what's on screen.
  const cacheKey = makeContextCacheKey({ view: 'compare', stateA: _state.a, stateB: _state.b });
  const context = getOrBuildContext('compare', cacheKey, () =>
    getCompareContext({ stateA: _state.a, stateB: _state.b }),
  );
  const myToken = ++_compareInsightToken;
  generateInsight('compare_insight', context, { cacheKey }).then((resp) => {
    if (myToken !== _compareInsightToken) return;
    if (resp?.source === 'gemini' && resp.result) {
      renderGeminiCompareInsight(resp.result, body);
      // No purple "Gemini-generated" badge — see atlas.js for rationale.
      clearCompareInsightBadge();
    } else {
      const sections = buildLocal();
      body.innerHTML = sections.map((s) => `<div class="gemini__section"><h4>${s.h}</h4><p>${s.p}</p></div>`).join('');
      // Match the Gemini path's typed-out reveal so the local fallback
      // is visually indistinguishable from the AI response.
      revealWords(body);
      // No badge on the local fallback — see atlas.js for rationale.
      clearCompareInsightBadge();
    }
    attachCopyButton(body, () => htmlToPlainText(body.innerHTML));
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderAtAGlance(cmp) {
  const wrap = document.getElementById('cmpAtAGlance');
  const list = document.getElementById('cmpAtAGlanceList');
  if (!wrap || !list) return;
  const items = Array.isArray(cmp.atAGlance) ? cmp.atAGlance.filter(Boolean) : [];
  if (!items.length) {
    wrap.hidden = true;
    list.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  list.innerHTML = items.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
}

function renderMostDistinct(cmp) {
  const wrap = document.getElementById('cmpMostDistinct');
  const text = document.getElementById('cmpMostDistinctText');
  if (!wrap || !text) return;
  if (!cmp.mostDistinctContrast) {
    wrap.hidden = true;
    text.textContent = '';
    return;
  }
  wrap.hidden = false;
  text.textContent = cmp.mostDistinctContrast;
}

function renderSimDiff(cmp) {
  const simHost = document.getElementById('cmpSimList');
  const diffHost = document.getElementById('cmpDiffList');
  if (simHost) {
    const sims = Array.isArray(cmp.similarities) ? cmp.similarities.filter(Boolean) : [];
    simHost.innerHTML = sims.length
      ? sims.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
      : '<li class="cmp-empty">No notable similarities above thresholds.</li>';
  }
  if (diffHost) {
    const diffs = Array.isArray(cmp.differences) ? cmp.differences.filter(Boolean) : [];
    diffHost.innerHTML = diffs.length
      ? diffs.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
      : '<li class="cmp-empty">No large differences above thresholds.</li>';
  }
}

function renderHeaders(cmp) {
  const sa = document.getElementById('cmpSwatchA');
  const sb = document.getElementById('cmpSwatchB');
  const ta = document.getElementById('cmpTotalA');
  const tb = document.getElementById('cmpTotalB');
  const na = document.getElementById('cmpNameA');
  const nb = document.getElementById('cmpNameB');
  if (sa) sa.textContent = _state.a;
  if (sb) sb.textContent = _state.b;
  if (na) na.textContent = STATE_NAMES[_state.a] || _state.a;
  if (nb) nb.textContent = STATE_NAMES[_state.b] || _state.b;
  if (ta) ta.textContent = fmtInt(cmp.kpis.a.total_athletes);
  if (tb) tb.textContent = fmtInt(cmp.kpis.b.total_athletes);
  renderProfileLabels();
}

function renderProfileLabels() {
  const wrap = document.getElementById('cmpProfileLabels');
  const hostA = document.getElementById('cmpLabelsA');
  const hostB = document.getElementById('cmpLabelsB');
  if (!hostA || !hostB) return;
  const labelsA = _state.a ? computeProfileLabels(_state.a) : [];
  const labelsB = _state.b ? computeProfileLabels(_state.b) : [];
  const chip = (text) => `<span class="cmp-profile-chip">${escapeHtml(text)}</span>`;
  hostA.innerHTML = labelsA.map(chip).join('');
  hostB.innerHTML = labelsB.map(chip).join('');
  if (wrap) wrap.hidden = !(labelsA.length || labelsB.length);
}

function isCompareAtDefaults() {
  return _state.a == null && _state.b == null;
}

function syncResetButtonState() {
  const btn = document.getElementById('cmpReset');
  if (!btn) return;
  btn.classList.toggle('is-default', isCompareAtDefaults());
}

function syncUrl() {
  updateUrlState({ a: _state.a || null, b: _state.b || null });
}

/**
 * Renders the Compare view in its "no states picked yet" state — placeholder
 * swatches/totals at the top, a friendly prompt where the side-by-side table
 * normally renders, and a Comparison Insight CTA.
 */
function renderEmptyState() {
  const sa = document.getElementById('cmpSwatchA'); if (sa) sa.textContent = '—';
  const sb = document.getElementById('cmpSwatchB'); if (sb) sb.textContent = '—';
  const na = document.getElementById('cmpNameA');   if (na) na.textContent = 'State A';
  const nb = document.getElementById('cmpNameB');   if (nb) nb.textContent = 'State B';
  const ta = document.getElementById('cmpTotalA');  if (ta) ta.textContent = '—';
  const tb = document.getElementById('cmpTotalB');  if (tb) tb.textContent = '—';

  const labelsWrap = document.getElementById('cmpProfileLabels');
  if (labelsWrap) {
    labelsWrap.hidden = true;
    const la = document.getElementById('cmpLabelsA'); if (la) la.innerHTML = '';
    const lb = document.getElementById('cmpLabelsB'); if (lb) lb.innerHTML = '';
  }

  const glance = document.getElementById('cmpAtAGlance');
  if (glance) {
    glance.hidden = true;
    const list = document.getElementById('cmpAtAGlanceList');
    if (list) list.innerHTML = '';
  }
  const md = document.getElementById('cmpMostDistinct');
  if (md) {
    md.hidden = true;
    const t = document.getElementById('cmpMostDistinctText');
    if (t) t.textContent = '';
  }

  const host = document.getElementById('compareRows');
  if (host) {
    host.innerHTML = '<div class="compare-empty">Pick two states above to compare participation, sport mix, Olympic and Paralympic representation, season profile, hometown hubs, and climate context.</div>';
  }

  const sim = document.getElementById('cmpSimList');  if (sim)  sim.innerHTML = '';
  const diff = document.getElementById('cmpDiffList'); if (diff) diff.innerHTML = '';

  // Restore the Comparison Insight card's empty-state placeholder — a friendly
  // "Pick Two States to Begin" prompt with quick-pick state pairs that
  // jump-start exploration. renderInsight() overwrites this once both states
  // are picked.
  const body = document.getElementById('cmpInsightBody');
  if (body) {
    const opts = compareOptions();
    const valid = (st) => opts.some((o) => o.st === st);
    const chips = EMPTY_COMPARE_PAIRS
      .filter((p) => valid(p.a) && valid(p.b))
      .map((p) => `<button type="button" class="cmp-empty-suggestions__chip" data-pair="${p.a},${p.b}">${p.label}</button>`)
      .join('');
    body.innerHTML = `
      <div class="gemini__section">
        <h4>Pick Two States to Begin</h4>
        <p>Choose any two states above to see a side-by-side profile across participation, sport mix, Olympic and Paralympic representation, season balance, hometown hubs, and climate context.</p>
        ${chips ? `
          <div class="cmp-empty-suggestions" role="group" aria-label="Try a pair">
            <span class="cmp-empty-suggestions__label">Try a pair</span>
            <div class="cmp-empty-suggestions__row">${chips}</div>
          </div>
        ` : ''}
      </div>
    `;
  }
  const follow = document.getElementById('cmpInsightFollow');
  if (follow) follow.innerHTML = '';
  clearCompareInsightBadge();
}

function rerender() {
  syncSelectGuards();
  if (!_state.a || !_state.b) {
    renderEmptyState();
    ensureInsightCopyButton();
    syncResetButtonState();
    syncUrl();
    return;
  }
  const cmp = compareStates(_state.a, _state.b);
  if (!cmp) return;
  const cacheKey = makeContextCacheKey({ view: 'compare', stateA: _state.a, stateB: _state.b });
  const context = getOrBuildContext('compare', cacheKey, () =>
    getCompareContext({ stateA: _state.a, stateB: _state.b }),
  );
  const _envelope = makeCompareBrief({
    title: `${STATE_NAMES[_state.a] || _state.a} ↔ ${STATE_NAMES[_state.b] || _state.b}`,
    similarities: cmp.similarities || [],
    differences: cmp.differences || [],
    mostDistinctContrast: cmp.mostDistinctContrast || '',
    caveat: '',
  });
  void context; void _envelope;
  renderAtAGlance(cmp);
  renderMostDistinct(cmp);
  renderHeaders(cmp);
  renderTable(cmp);
  renderSimDiff(cmp);
  renderInsight(cmp);
  // renderInsight() now attaches the copy button itself in every terminal
  // branch (Gemini success / Local fallback). We deliberately do NOT call
  // ensureInsightCopyButton() here — doing so would attach a button on the
  // loading skeleton that would copy "Gemini reading…".
  syncResetButtonState();
  syncUrl();
}

function ensureInsightCopyButton() {
  const body = document.getElementById('cmpInsightBody');
  if (!body) return;
  attachCopyButton(body, () => htmlToPlainText(body.innerHTML));
}

function wire() {
  document.getElementById('cmpSelectA')?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v && v === _state.b) return; // guard prevents this, but belt+braces
    _state.a = v || null;
    rerender();
  });
  document.getElementById('cmpSelectB')?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v && v === _state.a) return;
    _state.b = v || null;
    rerender();
  });
  // Compare Reset = drop both A + B picks and re-render. The rerender
  // hides the comparison cards (#cmpProfileLabels, #cmpAtAGlance,
  // #cmpMostDistinct, etc.) via `el.hidden=true`; the global
  // `[hidden]{display:none!important}` rule in base.css enforces that.
  document.getElementById('cmpReset')?.addEventListener('click', () => {
    _state.a = null; _state.b = null;
    const sa = document.getElementById('cmpSelectA'); if (sa) sa.value = '';
    const sb = document.getElementById('cmpSelectB'); if (sb) sb.value = '';
    rerender();
  });
  document.getElementById('cmpInsightBody')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.cmp-empty-suggestions__chip');
    if (!chip || !chip.dataset.pair) return;
    const [a, b] = chip.dataset.pair.split(',');
    const opts = compareOptions();
    const valid = (st) => st && !COMPARE_EXCLUDE.has(st) && opts.some((o) => o.st === st);
    if (!valid(a) || !valid(b) || a === b) return;
    _state.a = a;
    _state.b = b;
    const sa = document.getElementById('cmpSelectA'); if (sa) sa.value = _state.a;
    const sb = document.getElementById('cmpSelectB'); if (sb) sb.value = _state.b;
    rerender();
  });
  document.getElementById('cmpInsightFollow')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.followup-chip');
    if (!chip) return;
    if (chip.dataset.swap === 'ab') {
      const tmp = _state.a; _state.a = _state.b; _state.b = tmp;
    } else if (chip.dataset.pair) {
      const [a, b] = chip.dataset.pair.split(',');
      if (a && b && a !== b) { _state.a = a; _state.b = b; }
    }
    const sa = document.getElementById('cmpSelectA'); if (sa) sa.value = _state.a || '';
    const sb = document.getElementById('cmpSelectB'); if (sb) sb.value = _state.b || '';
    rerender();
  });
}

// First-load default A/B pair surfaced on the Compare page when no URL
// params provide a pre-selected pair. CA is the largest roster state;
// CO hosts the Olympic & Paralympic Training Center — together they're a
// strong, recognizable comparison that lights up every diff card on the
// page. The Reset button still clears back to no selection — defaults
// are first-load only, never re-applied after an explicit reset.
const DEFAULT_PAIR_ON_FIRST_LOAD = { a: 'CA', b: 'CO' };

registerView('compare', () => {
  const isFirstInit = !_initialised;
  if (!_initialised) {
    populateSelects();
    wire();
    _initialised = true;
  }
  // Allow other pages to deep-link with a preselected state (e.g. Atlas chip
  // "Compare California to another state" sets stateA: 'CA'). Either side may
  // arrive on its own — the other slot stays empty until the user picks.
  // Hash-driven entries (__fromHash) treat the URL as source of truth and
  // clear any prior selections before re-applying a/b.
  const params = consumeViewParams();
  if (params) {
    if (params.__fromHash) {
      _state.a = null;
      _state.b = null;
    }
    const opts = compareOptions();
    const valid = (st) => st && !COMPARE_EXCLUDE.has(st) && opts.some((o) => o.st === st);
    // Accept both new (a/b) and legacy (stateA/stateB) param keys.
    const inA = params.a || params.stateA;
    const inB = params.b || params.stateB;
    if (valid(inA)) {
      _state.a = inA;
      if (_state.b === _state.a) _state.b = null;
    }
    if (valid(inB) && inB !== _state.a) _state.b = inB;
    const sa = document.getElementById('cmpSelectA'); if (sa) sa.value = _state.a || '';
    const sb = document.getElementById('cmpSelectB'); if (sb) sb.value = _state.b || '';
  }

  // First-load default: pre-fill the A/B pair only if this is the very
  // first registerView tick AND nothing else (URL params, prior session)
  // already populated either slot. Reset wipes _state.a/b explicitly,
  // and re-entering the view doesn't re-trigger init, so the defaults
  // never reappear after a user reset.
  if (isFirstInit && !_state.a && !_state.b) {
    const opts = compareOptions();
    const valid = (st) => opts.some((o) => o.st === st);
    if (valid(DEFAULT_PAIR_ON_FIRST_LOAD.a) && valid(DEFAULT_PAIR_ON_FIRST_LOAD.b)) {
      _state.a = DEFAULT_PAIR_ON_FIRST_LOAD.a;
      _state.b = DEFAULT_PAIR_ON_FIRST_LOAD.b;
      const sa = document.getElementById('cmpSelectA'); if (sa) sa.value = _state.a;
      const sb = document.getElementById('cmpSelectB'); if (sb) sb.value = _state.b;
      syncUrl();
    }
  }
  rerender();
});
