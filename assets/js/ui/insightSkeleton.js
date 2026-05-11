/**
 * ui/insightSkeleton.js — shared loading skeleton + unified body
 * renderer for the four insight cards (Atlas / Sport / Parity /
 * Compare).
 *
 * The cards use a Gemini-first render pattern: show a skeleton with
 * a short "Gemini is reading…" label, then either render Gemini's
 * answer when it arrives or fall back to the deterministic write-up if
 * Gemini times out / errors.
 *
 * `renderInsightBody()` is the single entry point for painting the
 * final bullets. Both Gemini results and local fallbacks call it with
 * the same {title, bullets, caveat} envelope so the user sees the
 * same typography, spacing, and structure regardless of source. Both
 * paths also run through the shared word-by-word typewriter reveal so
 * the body feels typed out rather than appearing instantly.
 */

import { revealWords } from './typewriter.js';

export function renderInsightSkeleton(body, label = 'Gemini is reading the current view…') {
  if (!body) return;
  body.innerHTML = `
    <div class="gemini__section gemini__skeleton-block">
      <p class="gemini__skeleton-label">${label}</p>
      <div class="ask-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
  `;
}

/**
 * Render an insight card body using the unified bullet template.
 *
 * Local fallbacks and Gemini responses both flow through here so the
 * visual treatment (heading typography, bullet spacing, caveat style)
 * is identical no matter the source. Bullet strings may contain
 * limited inline HTML (e.g. <span class="accent">) — local builders
 * pass pre-formatted spans; Gemini bullets are plain strings and are
 * rendered as-is.
 *
 * @param {HTMLElement} body
 * @param {{ title?: string, bullets?: Array<string>, caveat?: string }} payload
 */
export function renderInsightBody(body, payload = {}) {
  if (!body) return;
  const title = payload.title || 'Insight';
  const bullets = Array.isArray(payload.bullets) ? payload.bullets.filter(Boolean) : [];
  const caveat = payload.caveat ? String(payload.caveat) : '';
  const bulletsHtml = bullets.length
    ? `<ul class="gemini__bullets">${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>`
    : '';
  const caveatHtml = caveat
    ? `<p class="gemini__caveat"><em>${caveat}</em></p>`
    : '';
  body.innerHTML = `
    <div class="gemini__section">
      <h4>${title}</h4>
      ${bulletsHtml}
      ${caveatHtml}
    </div>
  `;
  // Reveal bullets word-by-word so the card feels typed out. Same
  // animation runs for Gemini results and local fallbacks so the user
  // can't tell them apart by motion alone.
  revealWords(body);
}
