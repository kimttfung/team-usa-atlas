/**
 * pages/sport.js — Sport Explorer
 *
 * Searchable sport dropdown (#sportPicker) + Program/Season filters (#sportProgram, #sportSeason).
 * Renders into:
 *   - #sportNationalTitle / #sportProfileMeta
 *   - #sportStatTotal / #sportStatStates / #sportStatPara / #sportStatTopShare / #sportStatTopName
 *   - #sportSplitOly / #sportSplitPara / #sportSplitOlyVal / #sportSplitParaVal
 *   - #sportTopStatesTitle / #sportTopStates (.bar-list)
 *   - #sportDiversityList (.bar-list)
 *   - #sportInsightBody / #sportInsightFollow (locally-computed Sport Insight)
 */

import { registerView, updateUrlState, consumeViewParams } from '../lib/router.js';
import { getStore, STATE_NAMES } from '../data/store.js';
import { getAllSports, getSportSummary, topStatesForSport, topHometownsForSport, getSportPickerOptions, getSportPair, getSportFootprint, getSportFootprintType, getSportStateSpread, getTopHometownHubsForSport } from '../helpers/sports.js';
import { getSportDiversityRankings } from '../helpers/aggregates.js';
import { fmtInt, fmtPct, setText } from '../ui/kpi.js';
import { attachCopyButton, htmlToPlainText } from '../ui/copyButton.js';
import { getSportContext } from '../helpers/context.js';
import { makeContextCacheKey } from '../helpers/cacheKey.js';
import { makeSportBrief } from '../helpers/responseSchemas.js';
import { getOrBuildContext } from '../helpers/contextCache.js';
import { generateInsight } from '../lib/gemini.js';
import { renderInsightSkeleton, renderInsightBody } from '../ui/insightSkeleton.js';

const EMPTY_SPORT_SUGGESTIONS = [
  'Swimming',
  'Track and Field',
  'Cycling',
  'Wheelchair Basketball',
  'Para Track and Field',
];

// Para Variants are always merged into their Olympic sibling (e.g.
// "Track and Field (+ Para)" is one picker entry covering both Olympic and
// Paralympic Track and Field). The Program filter (Both / Olympic Only /
// Paralympic Only) handles the slice between the two. The previous "Listed
// Separately" mode caused confusing empty-states when users picked an Olympic
// sport name + Paralympic Only.
const _state = { sport: '', program: 'any', season: 'any', combinePara: true };
let _initialised = false;

function programFilter() { return _state.program === 'any' ? null : _state.program; }
function seasonFilter()  { return _state.season  === 'any' ? null : _state.season;  }
function helperOpts(extra = {}) {
  return { program: programFilter(), season: seasonFilter(), combinePara: _state.combinePara, ...extra };
}

function populateSportPicker() {
  const sel = document.getElementById('sportPicker');
  if (!sel) return;
  const options = getSportPickerOptions(_state.combinePara);
  const allSports = getAllSports();
  // Keep _state.sport stable: if combine is on and the user previously had a Para variant
  // selected, fold it back to its base name so the dropdown still has a matching option.
  if (_state.combinePara && _state.sport && _state.sport.startsWith('Para ') && allSports.includes(_state.sport.slice(5))) {
    _state.sport = _state.sport.slice(5);
  }
  // Empty selection is valid — it's the page's "nothing picked yet" default. Only fall
  // back to empty if the previously chosen sport is no longer in the option list.
  if (_state.sport && !options.some((o) => o.value === _state.sport)) {
    _state.sport = '';
  }
  sel.innerHTML = ['<option value="">— pick a sport —</option>']
    .concat(options.map((o) => `<option value="${o.value}">${o.label}</option>`))
    .join('');
  sel.value = _state.sport;
}

function renderEmptyProfile() {
  setText('sportNationalTitle', `Sport Profile · ${_state.sport}`);
  const meta = document.getElementById('sportProfileMeta');
  const filterText = [
    _state.program === 'any' ? null : _state.program,
    _state.season  === 'any' ? null : _state.season,
  ].filter(Boolean).join(' · ');
  if (meta) meta.textContent = filterText
    ? `No rows match ${filterText} for this sport`
    : 'No rows for this sport';

  setText('sportStatTotal',    '0');
  setText('sportStatStates',   '0');
  setText('sportStatPara',     '0');
  setText('sportStatTopShare', '0');
  setText('sportStatTopName',  '—');
  setText('sportStatHubs',     '0');
  setText('sportStatTopHub',   'distinct hometown hubs');
  setText('sportStatTop3Share', '0');
  setText('sportStatConcType',  '—');

  const oly  = document.getElementById('sportSplitOly');
  const para = document.getElementById('sportSplitPara');
  if (oly)  oly.style.width  = '0%';
  if (para) para.style.width = '0%';
  setText('sportSplitOlyVal',  '0');
  setText('sportSplitParaVal', '0');
  hideSportExtras();
}

function hideSportExtras() {
  const chip = document.getElementById('sportFootprintChip');
  const hubs = document.getElementById('sportHubsCard');
  if (chip)   chip.hidden   = true;
  if (hubs)   hubs.hidden   = true;
  const hubsList = document.getElementById('sportHubsList');
  if (hubsList) hubsList.innerHTML = '';
}

/**
 * Renders the page in its "no sport picked yet" state — placeholders in the
 * profile card, a friendly prompt in the top-states list and Sport Insight
 * panel. The Sport Variety ranking on the right stays live since it's a
 * global measure that's meaningful regardless of the picker.
 */
function renderEmptyState() {
  setText('sportNationalTitle', 'Sport Profile');
  const meta = document.getElementById('sportProfileMeta');
  if (meta) meta.textContent = 'Pick a sport to see its profile';

  setText('sportStatTotal',     '—');
  setText('sportStatStates',    '—');
  setText('sportStatPara',      '—');
  setText('sportStatTopShare',  '—');
  setText('sportStatTopName',   '—');
  setText('sportStatHubs',      '—');
  setText('sportStatTopHub',    'distinct hometown hubs');
  setText('sportStatTop3Share', '—');
  setText('sportStatConcType',  '—');

  const oly  = document.getElementById('sportSplitOly');
  const para = document.getElementById('sportSplitPara');
  if (oly)  oly.style.width  = '0%';
  if (para) para.style.width = '0%';
  setText('sportSplitOlyVal',  '—');
  setText('sportSplitParaVal', '—');

  hideSportExtras();

  setText('sportTopStatesTitle', 'Top States by Athletes');
  const topStates = document.getElementById('sportTopStates');
  if (topStates) {
    topStates.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">Pick a sport above to see its top states.</div>';
  }

  // Sport variety ranking is a global, sport-agnostic measure — keep it live.
  renderDiversityList();

  // Restore the Sport Insight card's empty-state placeholder — a friendly
  // "Pick a Sport to Begin" prompt with quick-pick suggestion chips that
  // jump-start exploration. renderInsight() overwrites this once a sport is
  // selected.
  const body = document.getElementById('sportInsightBody');
  if (body) {
    const picker = document.getElementById('sportPicker');
    const validSports = new Set(Array.from(picker?.options || []).map((o) => o.value));
    const chips = EMPTY_SPORT_SUGGESTIONS
      .filter((s) => validSports.has(s))
      .map((s) => `<button type="button" class="sport-empty-suggestions__chip" data-sport="${s}">${s}</button>`)
      .join('');
    body.innerHTML = `
      <div class="gemini__section">
        <h4>Pick a Sport to Begin</h4>
        <p>Choose any sport above to see its national footprint, top states, hometown hubs, season balance, and Olympic vs Paralympic mix.</p>
        ${chips ? `
          <div class="sport-empty-suggestions" role="group" aria-label="Try a sport">
            <span class="sport-empty-suggestions__label">Try a sport</span>
            <div class="sport-empty-suggestions__row">${chips}</div>
          </div>
        ` : ''}
      </div>
    `;
  }
  const follow = document.getElementById('sportInsightFollow');
  if (follow) follow.innerHTML = '';
}

function renderProfile() {
  const summary = getSportSummary(_state.sport, helperOpts());
  if (!summary) {
    renderEmptyProfile();
    return null;
  }
  const titleSuffix = summary.combined ? ' (Olympic + Para)' : '';
  setText('sportNationalTitle', `Sport Profile · ${_state.sport}${titleSuffix}`);
  const meta = document.getElementById('sportProfileMeta');
  // Meta line shows season only — program (Olympic/Paralympic/combined) is already
  // conveyed in the title to the left, and state count lives in the stats grid below.
  const seasonLabel = summary.season && summary.season !== 'Mixed' ? summary.season : null;
  if (meta) meta.textContent = seasonLabel || '—';

  setText('sportStatTotal',  fmtInt(summary.totalAthletes));
  setText('sportStatStates', fmtInt(summary.statesRepresented));
  setText('sportStatPara',   summary.totalAthletes ? ((summary.paralympic / summary.totalAthletes) * 100).toFixed(1) : '0');
  setText('sportStatTopShare', summary.totalAthletes && summary.topState ? ((summary.topState.athleteCount / summary.totalAthletes) * 100).toFixed(1) : '0');
  setText('sportStatTopName', summary.topState ? (STATE_NAMES[summary.topState.state] || summary.topState.state) : '—');
  setText('sportStatHubs', fmtInt(summary.hubsRepresented));
  if (summary.topHometown && summary.topHometown.city && summary.topHometown.state) {
    setText('sportStatTopHub', `Top hub: ${summary.topHometown.city}, ${summary.topHometown.state}`);
  } else {
    setText('sportStatTopHub', 'distinct hometown hubs');
  }

  // 6th tile: combined share of the 3 highest-rostered states + concentration label.
  // Driven by getSportFootprint (same helper that powered the removed Sport Footprint card).
  const fp = getSportFootprint(_state.sport, helperOpts());
  if (fp) {
    setText('sportStatTop3Share', String(Math.round((fp.top3Share || 0) * 100)));
    setText('sportStatConcType',  fp.type || '—');
  } else {
    setText('sportStatTop3Share', '0');
    setText('sportStatConcType',  '—');
  }

  const totalSplit = (summary.olympic || 0) + (summary.paralympic || 0);
  const olyPct  = totalSplit ? (summary.olympic  / totalSplit) * 100 : 0;
  const paraPct = totalSplit ? (summary.paralympic / totalSplit) * 100 : 0;
  const oly  = document.getElementById('sportSplitOly');
  const para = document.getElementById('sportSplitPara');
  if (oly)  oly.style.width  = `${olyPct.toFixed(1)}%`;
  if (para) para.style.width = `${paraPct.toFixed(1)}%`;
  setText('sportSplitOlyVal',  fmtInt(summary.olympic));
  setText('sportSplitParaVal', fmtInt(summary.paralympic));
  return summary;
}

// Top 10 states for the picked sport, ranked by athlete count and rendered
// as a horizontal bar list (bars normalized to the leading state).
function renderTopStates(summary) {
  const host = document.getElementById('sportTopStates');
  setText('sportTopStatesTitle', `Top States by Athletes · ${_state.sport}`);
  if (!host) return;
  const rows = topStatesForSport(_state.sport, helperOpts({ limit: 10 }));
  if (!rows.length) { host.innerHTML = '<div class="ranked-empty" style="font-size:12px;color:var(--muted-2);padding:8px 0;">No state rows for this filter combination.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.athleteCount));
  host.innerHTML = rows.map((r) => {
    const pct = max ? (r.athleteCount / max) * 100 : 0;
    return `
      <div class="bar-row">
        <div class="label">${STATE_NAMES[r.state] || r.state}</div>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="v">${fmtInt(r.athleteCount)}</div>
      </div>
    `;
  }).join('');
}

// Sport Variety leaderboard — global, picker-agnostic ranking of which
// states field the most distinct sports. Stays live even with no sport picked.
function renderDiversityList() {
  const host = document.getElementById('sportDiversityList');
  if (!host) return;
  const rows = getSportDiversityRankings(10);
  const max = Math.max(...rows.map((r) => r.sport_count));
  host.innerHTML = rows.map((r) => {
    const pct = max ? (r.sport_count / max) * 100 : 0;
    return `
      <div class="bar-row">
        <div class="label">${r.name}</div>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="v">${r.sport_count}</div>
      </div>
    `;
  }).join('');
}

// Token bumped on every renderInsight() call so an in-flight stale Gemini
// response can't overwrite a newer view.
let _sportInsightToken = 0;

function setSportInsightBadge(kind, label) {
  const head = document.querySelector('#sportInsightCard .gemini__head');
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

function clearSportInsightBadge() {
  const badge = document.querySelector('#sportInsightCard .gemini__head .gemini__source');
  if (badge) badge.remove();
}

function renderGeminiSportInsight(result, body) {
  renderInsightBody(body, {
    title: result?.title || 'Sport Insight',
    bullets: result?.bullets,
    caveat: result?.caveat,
  });
}

function renderInsight(summary) {
  const body = document.getElementById('sportInsightBody');
  const follow = document.getElementById('sportInsightFollow');
  if (!body) return;

  if (!_state.sport) {
    // Empty CTA branch — no Gemini call here.
    clearSportInsightBadge();
    return;
  }

  const filters = {
    program: _state.program === 'any' ? null : _state.program,
    season:  _state.season  === 'any' ? null : _state.season,
    paraVariants: _state.combinePara ? 'combined' : 'separate',
  };
  const cacheKey = makeContextCacheKey({ view: 'sport', sport: _state.sport, ...filters });
  const context = getOrBuildContext('sport', cacheKey, () =>
    getSportContext({ sport: _state.sport, filters }),
  );

  if (!summary) {
    // Filter combo with no data — keep the existing helpful message + chips,
    // skip Gemini entirely (nothing to interpret).
    const filterText = [
      _state.program === 'any' ? null : _state.program,
      _state.season  === 'any' ? null : _state.season,
    ].filter(Boolean).join(' + ');
    body.innerHTML = `
      <div class="gemini__section">
        <h4>No Data for This Filter Combination</h4>
        <p><span class="accent">${_state.sport}</span> has no rows matching <span class="accent">${filterText || 'this filter'}</span>. Try clearing the program or season filter.</p>
      </div>
    `;
    if (follow) {
      follow.innerHTML = `
        <button type="button" class="followup-chip" data-program="any" data-season="any">Clear Filters</button>
        <button type="button" class="followup-chip" data-program="any">Both Programs</button>
        <button type="button" class="followup-chip" data-season="any">All Seasons</button>
      `;
    }
    clearSportInsightBadge();
    attachCopyButton(body, () => htmlToPlainText(body.innerHTML));
    return;
  }

  // Build the deterministic write-up lazily; only paint it if Gemini fails.
  // Keep this list trimmed to ~4 sections so the local fallback length
  // stays roughly in line with a 4-6 bullet Gemini response. The previous
  // standalone "State Spread" section was dropped because the Snapshot
  // line already names the state + hub counts.
  const buildLocal = () => {
    const top3 = topStatesForSport(_state.sport, helperOpts({ limit: 3 }));
    const topHubs = topHometownsForSport(_state.sport, helperOpts({ limit: 3 }));
    const topShare = summary.totalAthletes && summary.topState ? summary.topState.athleteCount / summary.totalAthletes : 0;
    const sportLabel = summary.combined ? `${_state.sport} (Olympic + Para combined)` : _state.sport;
    const sections = [
      {
        h: 'Snapshot',
        p: `<span class="accent">${sportLabel}</span> totals <span class="accent">${fmtInt(summary.totalAthletes)}</span> athletes across <span class="accent">${summary.statesRepresented}</span> states and <span class="accent">${summary.hubsRepresented}</span> hometown hubs. Sport type: ${summary.sportType || '—'}; season: ${summary.season || '—'}.`,
      },
      top3.length ? {
        h: 'Where It Concentrates',
        p: `${top3.map((r) => `<span class="accent">${STATE_NAMES[r.state] || r.state}</span> (${fmtInt(r.athleteCount)})`).join(' · ')}. Top state holds ${fmtPct(topShare, 1)} of the sport.`,
      } : null,
      topHubs.length ? {
        h: 'Hometown Hubs',
        p: topHubs.map((h) => `<span class="accent">${h.city}, ${h.state}</span> (${fmtInt(h.athleteCount)})`).join(' · '),
      } : null,
      {
        h: 'Program Mix',
        p: `Olympic ${fmtInt(summary.olympic)} · Paralympic ${fmtInt(summary.paralympic)} (Paralympic share <span class="accent">${summary.totalAthletes ? fmtPct(summary.paralympic / summary.totalAthletes, 1) : '—'}</span>).`,
      },
    ].filter(Boolean);
    const _envelope = makeSportBrief({
      title: `${sportLabel} — Sport Insight`,
      bullets: sections.map((s) => htmlToPlainText(s.p)),
      caveat: '',
      followUps: ['Both Programs', 'Olympic Only', 'Paralympic Only'],
    });
    void _envelope;
    return sections;
  };

  // 1. Skeleton + Loading badge first.
  renderInsightSkeleton(body);
  setSportInsightBadge('loading', 'Gemini reading…');
  if (follow) {
    follow.innerHTML = `
      <button type="button" class="followup-chip" data-program="any">Both Programs</button>
      <button type="button" class="followup-chip" data-program="Olympic">Olympic Only</button>
      <button type="button" class="followup-chip" data-program="Paralympic">Paralympic Only</button>
    `;
  }

  // 2. Try Gemini. On success render its answer; on failure render the
  //    deterministic write-up. Either way, attach a fresh copy button at
  //    the end so the clipboard always reflects what's on screen.
  const myToken = ++_sportInsightToken;
  generateInsight('sport_insight', context, { cacheKey }).then((resp) => {
    if (myToken !== _sportInsightToken) return;
    if (resp?.source === 'gemini' && resp.result) {
      renderGeminiSportInsight(resp.result, body);
      // No purple "Gemini-generated" badge — see atlas.js for rationale.
      clearSportInsightBadge();
    } else {
      const sections = buildLocal();
      const sportLabel = summary.combined ? `${_state.sport} (Olympic + Para combined)` : _state.sport;
      renderInsightBody(body, {
        title: `${sportLabel} — Sport Insight`,
        // Plain bullets (no inline category prefix) so the local fallback
        // matches a Gemini response visually — same template, same
        // typography, same word-by-word reveal animation.
        bullets: sections.map((s) => s.p),
        caveat: '',
      });
      // No badge on the local fallback — see atlas.js for rationale.
      clearSportInsightBadge();
    }
    attachCopyButton(body, () => htmlToPlainText(body.innerHTML));
  });
}

// Footprint chip = small inline badge under the profile card showing the
// sport's national-spread classification ("Concentrated" / "Distributed" /
// etc.) + the share of athletes the top 3 states account for.
function renderFootprintChip(summary) {
  const chip = document.getElementById('sportFootprintChip');
  const typeEl = document.getElementById('sportFootprintType');
  const detailEl = document.getElementById('sportFootprintDetail');
  if (!chip || !typeEl || !detailEl) return;
  const fp = getSportFootprintType(_state.sport, helperOpts());
  if (!fp || !summary || !summary.totalAthletes) {
    chip.hidden = true;
    return;
  }
  typeEl.textContent = fp.type;
  const pct = Math.round(fp.topThreeShare * 100);
  detailEl.innerHTML = `Top 3 states account for <span class="sport-footprint-chip__share">${pct}%</span> of athletes in this sport.`;
  chip.hidden = false;
}

// Folded into the Sport Insight "Snapshot" + "Where It Concentrates"
// sections (see renderInsight). Kept as a callable helper so any code
// path that still references it (e.g. unit-test fixtures) stays safe;
// it now renders nothing when the standalone card has been removed
// from the DOM.
function renderStateSpread(summary) {
  const card = document.getElementById('sportSpreadCard');
  const body = document.getElementById('sportSpreadBody');
  if (!card || !body) return;
  const spread = getSportStateSpread(_state.sport, helperOpts());
  if (!spread || !summary || !summary.totalAthletes) {
    card.hidden = true;
    return;
  }
  const sportLabel = summary.combined ? `${_state.sport} (Olympic + Para)` : _state.sport;
  const topPct = (spread.topStateShare * 100).toFixed(1).replace(/\.0$/, '');
  body.innerHTML =
    `<span class="sport-spread__sport">${sportLabel}</span> appears across ` +
    `<span class="sport-spread__num">${fmtInt(spread.stateCount)}</span> states and ` +
    `<span class="sport-spread__num">${fmtInt(spread.hubCount)}</span> hometown hubs. ` +
    `Top state accounts for <span class="sport-spread__num">${topPct}%</span> of athletes in this sport.`;
  card.hidden = false;
}

// Top hometown hubs (cities) for the picked sport. Each row shows the
// city, a normalized bar, athlete count + share, and the Olympic/Paralympic
// breakdown if both are present.
function renderTopHubs(summary) {
  const card = document.getElementById('sportHubsCard');
  const list = document.getElementById('sportHubsList');
  const title = document.getElementById('sportHubsTitle');
  if (!card || !list) return;
  if (!summary || !summary.totalAthletes) {
    card.hidden = true;
    list.innerHTML = '';
    return;
  }
  const rows = getTopHometownHubsForSport(_state.sport, helperOpts({ limit: 10 }));
  if (!rows.length) {
    card.hidden = true;
    list.innerHTML = '';
    return;
  }
  if (title) title.textContent = `Top Hometown Hubs for This Sport · ${_state.sport}`;
  const max = Math.max(...rows.map((r) => r.athletes));
  list.innerHTML = rows.map((r) => {
    const pct = max ? (r.athletes / max) * 100 : 0;
    const share = (r.share * 100).toFixed(1).replace(/\.0$/, '');
    const splitParts = [];
    if (r.olympic)    splitParts.push(`${fmtInt(r.olympic)} Oly`);
    if (r.paralympic) splitParts.push(`${fmtInt(r.paralympic)} Para`);
    const split = splitParts.length ? splitParts.join(' · ') : '—';
    return `
      <div class="sport-hub-row">
        <div class="sport-hub-row__city">${r.city}, ${r.state}</div>
        <div class="sport-hub-row__bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="sport-hub-row__count">${fmtInt(r.athletes)}</div>
        <div class="sport-hub-row__share">${share}%</div>
        <div class="sport-hub-row__split">${split}</div>
      </div>
    `;
  }).join('');
  card.hidden = false;
}

function rerender() {
  if (!_state.sport) {
    renderEmptyState();
    ensureInsightCopyButton();
    return;
  }
  const summary = renderProfile();
  renderTopStates(summary);
  renderDiversityList();
  renderFootprintChip(summary);
  // The legacy "State Spread" card was removed and its sentence was folded
  // into the Sport Insight Snapshot section, so there's no separate render
  // call here anymore. renderTopHubs and renderInsight cover everything
  // that card used to surface (state count, hub count, top-state share).
  renderTopHubs(summary);
  renderInsight(summary);
  // Note: renderInsight now attaches the copy button itself in every
  // terminal branch (Gemini success / Local fallback / no-data) so the
  // clipboard always reflects the final on-screen content. We deliberately
  // do NOT call ensureInsightCopyButton() here — doing so would attach a
  // button on the loading skeleton that copies "Gemini reading…".
}

function ensureInsightCopyButton() {
  const body = document.getElementById('sportInsightBody');
  if (!body) return;
  attachCopyButton(body, () => htmlToPlainText(body.innerHTML));
}

function syncUrl() {
  updateUrlState({
    sport: _state.sport || null,
    program: _state.program && _state.program !== 'any' ? _state.program : null,
    season: _state.season && _state.season !== 'any' ? _state.season : null,
  });
}

function wireFilters() {
  const picker  = document.getElementById('sportPicker');
  const program = document.getElementById('sportProgram');
  const season  = document.getElementById('sportSeason');
  const reset   = document.getElementById('sportFilterReset');
  if (picker)  picker.addEventListener('change',  () => { _state.sport   = picker.value;  rerender(); syncUrl(); });
  if (program) program.addEventListener('change', () => { _state.program = program.value; rerender(); syncUrl(); });
  if (season)  season.addEventListener('change',  () => { _state.season  = season.value;  rerender(); syncUrl(); });
  // Reset handler: zero out every filter (sport / program / season) and
  // re-render. The rerender path falls into renderEmptyState() which
  // calls hideSportExtras() — that toggles `el.hidden=true` on the
  // chip + spread + hubs cards. The global `[hidden]{display:none
  // !important}` rule in base.css guarantees those toggles actually
  // hide the elements (without it, an explicit `display: flex/grid`
  // declaration in CSS would silently win and the cards would stay
  // visible with stale text).
  if (reset)   reset.addEventListener('click', () => {
    _state.program = 'any';
    _state.season = 'any';
    _state.sport = '';
    if (program) program.value = 'any';
    if (season)  season.value  = 'any';
    populateSportPicker();
    rerender();
    syncUrl();
  });
  document.getElementById('sportInsightBody')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.sport-empty-suggestions__chip');
    if (!chip || !chip.dataset.sport) return;
    const next = chip.dataset.sport;
    const picker = document.getElementById('sportPicker');
    const options = Array.from(picker?.options || []).map((o) => o.value);
    if (!options.includes(next)) return;
    _state.sport = next;
    if (picker) picker.value = next;
    rerender();
    syncUrl();
  });
  document.getElementById('sportInsightFollow')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.followup-chip');
    if (!chip) return;
    let dirty = false;
    if (chip.dataset.program) {
      _state.program = chip.dataset.program;
      if (program) program.value = _state.program;
      dirty = true;
    }
    if (chip.dataset.season) {
      _state.season = chip.dataset.season;
      if (season) season.value = _state.season;
      dirty = true;
    }
    if (dirty) { rerender(); syncUrl(); }
  });
}

function populateProgramSelect() {
  const sel = document.getElementById('sportProgram');
  if (!sel) return;
  const { PROGRAMS } = getStore();
  sel.innerHTML = '<option value="any" selected>Both</option>' +
    PROGRAMS.map((p) => `<option value="${p}">${p} Only</option>`).join('');
  sel.value = _state.program;
}
function populateSeasonSelect() {
  const sel = document.getElementById('sportSeason');
  if (!sel) return;
  const { SEASONS } = getStore();
  sel.innerHTML = '<option value="any" selected>All Seasons</option>' +
    SEASONS.map((s) => `<option value="${s}">${s}</option>`).join('');
  sel.value = _state.season;
}

// Default sport surfaced on first visit when the user hasn't pinned
// one via the URL. "Track and Field" is the broadest, most data-rich
// Olympic + Paralympic sport, so the page lands with meaningful charts
// on first load instead of an empty-state placeholder. The Reset button
// always clears back to the empty selection — defaults are first-load
// only, never re-applied after the user explicitly chooses to reset.
const DEFAULT_SPORT_ON_FIRST_LOAD = 'Track and Field';

registerView('sport', () => {
  const isFirstInit = !_initialised;
  if (!_initialised) {
    populateProgramSelect();
    populateSeasonSelect();
    populateSportPicker();
    wireFilters();
    _initialised = true;
  }

  const params = consumeViewParams();
  if (params && typeof params === 'object') {
    if (params.__fromHash) {
      // URL is source of truth: reset filters before applying URL params so an
      // empty hash (e.g. back-button to #/sport) clears any prior selections.
      _state.sport = '';
      _state.program = 'any';
      _state.season = 'any';
    }
    const allSports = getAllSports();
    if (params.sport && (allSports.includes(params.sport) || getSportPickerOptions(_state.combinePara).some((o) => o.value === params.sport))) {
      _state.sport = params.sport;
    }
    if (params.program) _state.program = params.program;
    if (params.season)  _state.season  = params.season;

    const picker  = document.getElementById('sportPicker');
    const program = document.getElementById('sportProgram');
    const season  = document.getElementById('sportSeason');
    populateSportPicker();
    if (picker)  picker.value  = _state.sport;
    if (program) program.value = _state.program;
    if (season)  season.value  = _state.season;
  }

  // First-load default: only when this is the page's first registerView
  // tick AND nothing else (URL params, prior session) populated _state.sport.
  if (isFirstInit && !_state.sport) {
    const opts = getSportPickerOptions(_state.combinePara).map((o) => o.value);
    if (opts.includes(DEFAULT_SPORT_ON_FIRST_LOAD)) {
      _state.sport = DEFAULT_SPORT_ON_FIRST_LOAD;
      const picker = document.getElementById('sportPicker');
      if (picker) picker.value = _state.sport;
      syncUrl();
    }
  }

  rerender();
  syncUrl();
});
