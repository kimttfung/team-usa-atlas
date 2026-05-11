/**
 * pages/ask.js — Ask the Analyst
 *
 * Chips-only deterministic v1. Free-text submit either rewrites unsafe
 * phrasings into a safer suggestion or shows a polite "no match" message —
 * never invents an answer.
 *
 * Renders into:
 *   - #askMessages       — message thread
 *   - #askQuickChips     — chips above the input
 *   - #askSuggestionList — suggestion card (right column)
 *   - #askForm / #askInput — input form
 */

import { registerView, consumeViewParams, updateUrlState } from '../lib/router.js';
import { SUGGESTED_QUESTIONS, answerQuestion, rephraseUnsafeQuestion } from '../helpers/analyst.js';
import { attachCopyButton, htmlToPlainText } from '../ui/copyButton.js';
import { classifyAnalystQuestion, INTENTS } from '../helpers/intent.js';
import { getAskContext } from '../helpers/context.js';
import { makeContextCacheKey } from '../helpers/cacheKey.js';
import { makeAskAnswer } from '../helpers/responseSchemas.js';
import { buildEvidence } from '../helpers/evidenceModel.js';
import { getOrBuildContext } from '../helpers/contextCache.js';
import { generateAskAnswer } from '../lib/gemini.js';
import { revealWords } from '../ui/typewriter.js';

const CATEGORY_ORDER = ['Geography', 'Sports', 'Parity', 'Compare', 'Climate Context'];

// Free-text intents we let Gemini interpret. The chip-match short-circuit
// runs first, so this set only matters when the question is genuinely
// off-script. UNSUPPORTED_OR_UNSAFE is intentionally absent.
const GEMINI_READY_INTENTS = new Set([
  INTENTS.TOP_STATES,
  INTENTS.TOP_HOMETOWN_HUBS,
  INTENTS.SPORT_FOOTPRINT,
  INTENTS.SPORT_CONCENTRATION,
  INTENTS.SPORT_DIVERSITY,
  INTENTS.PARITY_STATES,
  INTENTS.PARITY_HUBS,
  INTENTS.PARITY_SPORTS,
  INTENTS.COMPARE_STATES,
  INTENTS.WINTER_SHARE,
  INTENTS.CLIMATE_CONTEXT,
]);

let _initialised = false;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function chipBtn(q, cls = 'followup-chip') {
  return `<button type="button" class="${cls}" data-q="${q.id}">${q.label}</button>`;
}
function followupBtn(qId, label) {
  const found = SUGGESTED_QUESTIONS.find((x) => x.id === qId);
  return `<button type="button" class="followup-chip" data-q="${qId}">${label || found?.label || qId}</button>`;
}
// followupTextBtn / renderFollowups removed: bot messages no longer
// render follow-up chip pills under each answer. The decline card uses
// followupBtn() directly for its single rescue chip.

function populateSuggestions() {
  const visibleQuestions = SUGGESTED_QUESTIONS.filter((q) => !q.hidden);
  const list = document.getElementById('askSuggestionList');
  if (list) {
    const groups = CATEGORY_ORDER
      .map((cat) => {
        const items = visibleQuestions.filter((q) => q.category === cat);
        if (!items.length) return '';
        return `
          <div class="ask-cat-group" data-cat="${cat}">
            <div class="ask-cat-head">${cat}</div>
            <div class="ask-cat-chips">${items.map((q) => chipBtn(q)).join('')}</div>
          </div>
        `;
      })
      .join('');
    list.innerHTML = groups;
  }

  const chips = document.getElementById('askQuickChips');
  const quick = visibleQuestions.slice(0, 4);
  if (chips) chips.innerHTML = quick.map((q) =>
    `<button type="button" class="followup-chip" data-q="${q.id}">${q.label}</button>`
  ).join('');
}

function renderTable(table) {
  if (!table || !table.rows?.length) return '';
  const colCount = table.columns.length;
  const colWidth = colCount > 0 ? `${(100 / colCount).toFixed(4)}%` : 'auto';
  const colgroup = `<colgroup>${table.columns.map(() => `<col style="width:${colWidth};" />`).join('')}</colgroup>`;
  const head = table.columns.map((c) => `<th style="text-align:left;font-weight:600;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding:8px 12px 8px 0;border-bottom:1px solid var(--border);word-break:break-word;">${c}</th>`).join('');
  const body = table.rows.map((r) =>
    `<tr>${r.map((c) => `<td style="padding:8px 12px 8px 0;font-size:12.5px;color:var(--fg);font-variant-numeric:tabular-nums;word-break:break-word;vertical-align:top;">${c}</td>`).join('')}</tr>`
  ).join('');
  // data-typewriter-skip keeps the per-cell numbers from being faded in
  // word-by-word — tabular data should appear at once so the row order
  // and column alignment stay obvious.
  return `<table data-typewriter-skip="true" style="border-collapse:collapse;width:100%;table-layout:fixed;margin-top:12px;">${colgroup}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Strips the on-disk file extension from a source-table identifier so the
// Ask evidence row reads as a roster table name (e.g. `state_summary`)
// rather than a static file path. The methodology page renders a separate
// evidence panel that intentionally keeps the full file names — that's
// the one place the underlying storage format is surfaced.
// displaySource and renderEvidenceBlock removed: bot messages no longer
// render an Evidence Used block or follow-up chip pills.

const GEM_SVG = '<img src="assets/img/google-gemini.svg" alt="" width="22" height="22" />';

function pushUserMsg(text) {
  const host = document.getElementById('askMessages');
  if (!host) return;
  const div = document.createElement('div');
  div.className = 'ask-msg user';
  div.innerHTML = `
    <div class="ava ava--user" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>
    </div>
    <div class="body"><p>${text}</p></div>
  `;
  host.appendChild(div);
  host.scrollTop = host.scrollHeight;
}

function pushBotMsg({ headline, bullets, table, evidence }) {
  const host = document.getElementById('askMessages');
  if (!host) return;
  void evidence;
  const div = document.createElement('div');
  div.className = 'ask-msg bot';
  const bulletList = bullets?.length
    ? `<ul style="margin:0 0 8px;padding-left:18px;">${bullets.map((b) => `<li style="margin:3px 0;">${b}</li>`).join('')}</ul>`
    : '';
  // Source badges and follow-up chip pills are intentionally omitted —
  // the user has asked for both to be removed across the chat. Every
  // bot message is rendered the same way, regardless of whether the
  // answer came from Gemini or a deterministic chip handler.
  div.innerHTML = `
    <div class="ava ava--gem">${GEM_SVG}</div>
    <div class="body">
      <p><strong>${headline}</strong></p>
      ${bulletList}
      ${renderTable(table)}
    </div>
  `;
  host.appendChild(div);
  const bodyEl = div.querySelector('.body');
  if (bodyEl) {
    attachCopyButton(bodyEl, () => htmlToPlainText(bodyEl.innerHTML));
    // Word-by-word typewriter reveal so every bot message — Gemini-
    // generated or deterministic — feels typed out. Tables and the
    // copy button are excluded by SKIP_TAGS in revealWords so only
    // the prose animates.
    revealWords(bodyEl);
  }
  host.scrollTop = host.scrollHeight;
}

function pushThinkingMsg(label = 'Gemini is reading the current view…') {
  const host = document.getElementById('askMessages');
  if (!host) return null;
  const div = document.createElement('div');
  div.className = 'ask-msg bot ask-thinking';
  div.innerHTML = `
    <div class="ava ava--gem">${GEM_SVG}</div>
    <div class="body">
      <p style="color:var(--muted);margin:0 0 8px;">${label}</p>
      <div class="ask-skeleton"><span></span><span></span><span></span></div>
    </div>
  `;
  host.appendChild(div);
  host.scrollTop = host.scrollHeight;
  return div;
}

// Randomized "thinking" pause used when we know the answer is local /
// hardcoded but want every bot message in the Ask chat — including the
// intro, the decline/unmatched cards, and direct-chip deterministic
// answers — to feel Gemini-generated. Keeps the typing-indicator UX
// consistent regardless of whether the answer ever touched Gemini.
function randomThinkingMs(min = 700, max = 1300) {
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * Show the Gemini skeleton/thinking row, wait `ms` (or a randomized
 * default), then remove the skeleton and run the painter that actually
 * appends the bot message. Returns a Promise that resolves once the
 * real message is on screen.
 */
async function withThinking(painter, { ms, label } = {}) {
  const thinking = pushThinkingMsg(label);
  await new Promise((r) => setTimeout(r, ms ?? randomThinkingMs()));
  if (thinking) thinking.remove();
  painter();
}

function pushDeclineCard({ declineReason, safeQuestionId }) {
  const host = document.getElementById('askMessages');
  if (!host) return;
  const safe = SUGGESTED_QUESTIONS.find((q) => q.id === safeQuestionId);
  // Single rescue chip: not a "follow-up" pill but a path-forward
  // affordance, so it stays even though general follow-up pills were
  // removed from bot messages.
  const safeChip = safe
    ? `<div class="followup">${followupBtn(safe.id, safe.label)}</div>`
    : '';
  const div = document.createElement('div');
  div.className = 'ask-msg bot ask-decline';
  div.innerHTML = `
    <div class="ava ava--gem">${GEM_SVG}</div>
    <div class="body">
      <p><strong>I can't answer that directly</strong></p>
      <p>${declineReason}</p>
      <p style="color:var(--muted);">A safer aggregate version is:</p>
      ${safeChip}
    </div>
  `;
  host.appendChild(div);
  const bodyEl = div.querySelector('.body');
  if (bodyEl) revealWords(bodyEl);
  host.scrollTop = host.scrollHeight;
}

// Friendly refusal shown when Gemini's general path also can't ground
// an answer in the roster. Replaces the older hard-stop muted message
// ("Atlas only answers from a fixed set…") which felt brusque now that
// Gemini does try every question.
function pushGroundingRefusal() {
  const host = document.getElementById('askMessages');
  if (!host) return;
  const div = document.createElement('div');
  div.className = 'ask-msg bot ask-muted';
  div.innerHTML = `
    <div class="ava ava--gem">${GEM_SVG}</div>
    <div class="body">
      <p>I couldn't ground that one in the roster data.</p>
      <p style="color:var(--muted);">Try asking about state distribution, hometown hubs, sport mix, season mix, or Paralympic representation.</p>
    </div>
  `;
  host.appendChild(div);
  const bodyEl = div.querySelector('.body');
  if (bodyEl) revealWords(bodyEl);
  host.scrollTop = host.scrollHeight;
}

// Hardcoded intro message painter — the actual welcome text. Wrapped
// by pushIntroIfEmpty() in a thinking-skeleton + delay so even this
// canned message feels Gemini-generated.
function paintIntroMessage() {
  const host = document.getElementById('askMessages');
  if (!host) return;
  const div = document.createElement('div');
  div.className = 'ask-msg bot ask-intro';
  div.innerHTML = `
    <div class="ava ava--gem">${GEM_SVG}</div>
    <div class="body">
      <p><strong>Ask aggregate questions about states, hometown hubs, sports, seasons, and Paralympic representation.</strong></p>
      <p style="color:var(--muted);">Answers stay at the state and hub level — no individual athletes, no medal counts, no per-capita rates. Every answer cites the roster slice and fields it was computed from.</p>
      <p style="color:var(--muted);">Pick a suggested question on the right, or use a quick chip below to get started.</p>
    </div>
  `;
  host.appendChild(div);
  const bodyEl = div.querySelector('.body');
  if (bodyEl) revealWords(bodyEl);
  host.scrollTop = host.scrollHeight;
}

function pushIntroIfEmpty() {
  const host = document.getElementById('askMessages');
  if (!host || host.children.length > 0) return;
  // Even though the intro is hardcoded, run it through the same
  // thinking-skeleton flow so every bot message in the chat feels
  // Gemini-generated. Slightly longer pause (1000-1700ms) makes the
  // first message feel intentional rather than instant.
  withThinking(paintIntroMessage, { ms: randomThinkingMs(1000, 1700) });
}

async function handleQuestion(qId, opts = {}) {
  const q = SUGGESTED_QUESTIONS.find((x) => x.id === qId);
  if (!q) return;
  pushUserMsg(q.label);
  if (opts.updateUrl !== false) updateUrlState({ q: qId });

  const ans = answerQuestion(qId);
  if (!ans) return;

  const classified = classifyAnalystQuestion(q.label);

  if (classified.intent && GEMINI_READY_INTENTS.has(classified.intent)) {
    const handled = await tryGeminiAskAnswer({
      text: q.label,
      classified,
      fallbackHandlerId: qId,
    });
    if (handled) return;
  }

  const evFirst = Array.isArray(ans.evidence) && ans.evidence[0] ? ans.evidence[0] : null;
  const _envelope = makeAskAnswer({
    title: ans.headline || q.label,
    bullets: ans.bullets || [],
    table: ans.table || { columns: [], rows: [] },
    evidence: buildEvidence({
      files: evFirst?.files || [],
      fields: evFirst?.fields || [],
      rowCount: evFirst?.rowCount,
      notes: evFirst?.notes || [],
    }),
    caveat: '',
    followUps: (ans.related || []).map((r) => (typeof r === 'string' ? r : r.label || r.id || '')),
  });
  void _envelope;
  // Even the deterministic chip path runs through the thinking skeleton
  // so every bot reply feels Gemini-generated.
  await withThinking(() => pushBotMsg({ ...ans }));
}

// Render a Gemini ask_answer JSON envelope into the same pushBotMsg shape
// the chip handlers use, so the visual treatment is identical. Source
// badges and follow-up chip pills are intentionally omitted — the user
// has asked for both to be removed across the chat.
function renderGeminiAskAnswer(result, deterministicEvidence) {
  const tableColumns = result?.table?.columns || [];
  const tableRows = (result?.table?.rows || []).map((r) => [
    r.label ?? '',
    r.value ?? '',
    r.secondary ?? '',
  ].filter((v, i, a) => i < tableColumns.length || (i === a.length - 1 && v !== '')));
  pushBotMsg({
    headline: result?.title || 'Analyst answer',
    bullets: [
      ...(result?.bullets || []),
      ...(result?.caveat ? [`<em style="color:var(--muted);">${result.caveat}</em>`] : []),
    ],
    table: tableColumns.length ? { columns: tableColumns, rows: tableRows } : null,
    evidence: deterministicEvidence,
  });
}

async function tryGeminiAskAnswer({ text, classified, fallbackHandlerId }) {
  const cacheKey = makeContextCacheKey({
    view: 'ask',
    intent: classified.intent,
    q: text,
  });
  const askContext = getOrBuildContext('ask', cacheKey, () =>
    getAskContext({ intent: classified.intent, entities: classified.entities, question: text })
  );

  const thinking = pushThinkingMsg();
  const resp = await generateAskAnswer({
    question: text,
    intent: classified.intent,
    entities: classified.entities,
    facts: askContext.facts,
    evidence: askContext.evidence,
  });
  if (thinking) thinking.remove();

  // Build the deterministic Evidence Used block from the same context the
  // server saw — never let Gemini author this block.
  const askEvidence = askContext.evidence || { files: [], fields: [], rowCount: 0 };
  const evForRender = [{
    file: askEvidence.files?.[0] || '',
    files: askEvidence.files || [],
    fields: askEvidence.fields || [],
    rowCount: askEvidence.rowCount,
    note: '',
  }];

  if (resp?.source === 'gemini' && resp.result) {
    renderGeminiAskAnswer(resp.result, evForRender);
    return true;
  }

  // Gemini failed: fall back to the deterministic handler if we have one.
  // No "Local insight" badge — absence of the purple Gemini badge is
  // itself the "this wasn't AI-generated" signal across the app.
  if (fallbackHandlerId) {
    const ans = answerQuestion(fallbackHandlerId);
    if (ans) {
      pushBotMsg({ ...ans });
      return true;
    }
  }
  return false;
}

async function routeFreeText(text, { alreadyPushedUser = false } = {}) {
  if (!alreadyPushedUser) pushUserMsg(text);

  const classified = classifyAnalystQuestion(text);

  // 1. Direct chip match — exact deterministic handler. Reliable demo path.
  if (classified.intent && classified.intent !== INTENTS.UNSUPPORTED_OR_UNSAFE) {
    const exactChip = SUGGESTED_QUESTIONS.find((x) => x.intent === classified.intent && !x.hidden)
      || SUGGESTED_QUESTIONS.find((x) => x.intent === classified.intent);
    const chipMatchesExactly = exactChip && exactChip.label.toLowerCase() === text.trim().toLowerCase();
    if (chipMatchesExactly) {
      const ans = answerQuestion(exactChip.id);
      if (ans) {
        await withThinking(() => pushBotMsg(ans));
        updateUrlState({ q: exactChip.id, text: null });
        return true;
      }
    }
  }

  // 2. Unsafe wording — rephrase and decline before any Gemini call.
  const rephrased = rephraseUnsafeQuestion(text);
  if (rephrased) {
    await withThinking(() => pushDeclineCard(rephrased));
    return true;
  }

  // 3. Gemini-ready free text — classify, build context, call Gemini,
  //    fall back to the closest deterministic handler on any failure.
  if (classified.intent && GEMINI_READY_INTENTS.has(classified.intent)) {
    const fallbackChip = SUGGESTED_QUESTIONS.find((x) => x.intent === classified.intent && !x.hidden)
      || SUGGESTED_QUESTIONS.find((x) => x.intent === classified.intent);
    const handled = await tryGeminiAskAnswer({
      text,
      classified,
      fallbackHandlerId: fallbackChip?.id || null,
    });
    if (handled) {
      updateUrlState({ text, q: null });
      return true;
    }
  }

  // 4. No matching narrow intent — try Gemini with the broad "general"
  //    facts payload. This is the "answer anything" path: Gemini gets
  //    state distribution, hometown hubs, sport diversity, winter share,
  //    and parity figures, and either grounds an answer in them or
  //    returns a polite refusal which we surface via pushGroundingRefusal.
  const generalHandled = await tryGeminiAskAnswer({
    text,
    classified: { intent: 'general', entities: classified.entities || {} },
    fallbackHandlerId: null,
  });
  if (generalHandled) {
    updateUrlState({ text, q: null });
    return true;
  }

  // 5. Gemini also failed (timeout, network, validation) — show the
  //    friendly grounding refusal rather than the old hard-stop message.
  await withThinking(() => pushGroundingRefusal());
  return false;
}

function clearChat() {
  const host = document.getElementById('askMessages');
  if (host) host.innerHTML = '';
  const input = document.getElementById('askInput');
  if (input) input.value = '';
  updateUrlState({ q: null, text: null });
  pushIntroIfEmpty();
}

function wire() {
  document.querySelector('section.view[data-view="ask"]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-q], button[data-text]');
    if (!btn) return;
    if (btn.dataset.q) {
      handleQuestion(btn.dataset.q);
    } else if (btn.dataset.text) {
      routeFreeText(btn.dataset.text);
    }
  });

  document.getElementById('askNewChat')?.addEventListener('click', clearChat);

  const form = document.getElementById('askForm');
  const input = document.getElementById('askInput');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = (input?.value || '').trim();
      if (!text) return;
      input.value = '';
      routeFreeText(text);
    });
  }
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form?.requestSubmit();
      }
    });
  }

  const topForm = document.getElementById('topbarAskForm');
  if (topForm && !topForm.dataset.wired) {
    topForm.dataset.wired = 'true';
    topForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ti = document.getElementById('topbarAskInput');
      const text = (ti?.value || '').trim();
      if (!text) return;
      if (ti) ti.value = '';
      const { setView } = await import('../lib/router.js');
      setView('ask', { text });
    });
  }
}

registerView('ask', () => {
  if (!_initialised) {
    populateSuggestions();
    wire();
    _initialised = true;
  }
  // Read view params first (deep links like setView('ask', {q:'foo'}))
  // before wiping the chat — that way a deep-link still fires its
  // initial question, but a normal sidebar nav back to Ask gets a
  // truly fresh chat with no carryover history.
  const params = consumeViewParams();
  const host = document.getElementById('askMessages');
  if (host) host.innerHTML = '';
  const input = document.getElementById('askInput');
  if (input) input.value = '';
  // Also clear any leftover ?q= / ?text= from a previous chip-click,
  // so navigating away and back doesn't auto-replay the last answer.
  if (!params?.q && !params?.questionId && !params?.text) {
    updateUrlState({ q: null, text: null });
  }
  const qId = params?.q || params?.questionId;
  if (qId && SUGGESTED_QUESTIONS.find((x) => x.id === qId)) {
    // Deep link to a chip: skip the intro entirely so the user message
    // + Gemini answer take over the fresh chat without an orphaned
    // intro skeleton hanging around above the user bubble.
    handleQuestion(qId, { updateUrl: false });
  } else if (params?.text) {
    routeFreeText(params.text);
  } else {
    pushIntroIfEmpty();
  }
});
