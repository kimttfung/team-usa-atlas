/**
 * ui/typewriter.js — progressive word-reveal animation.
 *
 * Walks all text nodes in `root`, splits them into per-word spans,
 * hides them all, then progressively reveals each span on a fixed
 * cadence. Used across the four insight cards and the Ask the Analyst
 * chat to make every bot-style message — Gemini-generated or local —
 * feel typed-out rather than instant.
 *
 * Design choices:
 *   - Word-level (not character-level): cleaner, easier to read mid-flight,
 *     and avoids visible reflow on every keystroke.
 *   - Opacity-only reveal (not display:none): preserves the final layout
 *     during animation so the surrounding card doesn't visibly resize.
 *     The host card is sized for the full content from frame 1.
 *   - Skips text inside <button>, <style>, <script>, <input>, <textarea>,
 *     and any subtree marked with [data-typewriter-skip="true"]. This
 *     keeps chip pills, copy buttons, and form controls from being
 *     animated, since their text isn't conversational content.
 *   - Respects prefers-reduced-motion: when the user has it set, all
 *     words paint immediately and no animation runs.
 *   - Returns a cancel function; callers can use it to bail out (for
 *     example when a stale Gemini response arrives after a filter
 *     change and a newer reveal is already mid-flight).
 */

const SKIP_TAGS = new Set([
  'BUTTON',
  'STYLE',
  'SCRIPT',
  'NOSCRIPT',
  'INPUT',
  'TEXTAREA',
  'SELECT',
]);

const PREFERS_REDUCED = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

/**
 * Reveal text inside `root` word-by-word.
 *
 * @param {HTMLElement|null} root
 * @param {{ wordDelayMs?: number, onDone?: () => void }} [opts]
 * @returns {() => void} cancel function — finishes the reveal immediately.
 */
export function revealWords(root, { wordDelayMs = 22, onDone } = {}) {
  if (!root) return () => {};
  if (PREFERS_REDUCED?.matches) {
    if (onDone) onDone();
    return () => {};
  }
  const wordSpans = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      let p = n.parentElement;
      while (p && p !== root) {
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.dataset && p.dataset.typewriterSkip === 'true') return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const node of textNodes) {
    const parent = node.parentNode;
    if (!parent) continue;
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    // Split on whitespace runs, keeping the whitespace as plain text so
    // the rendered spacing matches the original markup exactly.
    const parts = text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        const span = document.createElement('span');
        span.className = 'tw-word';
        span.textContent = part;
        frag.appendChild(span);
        wordSpans.push(span);
      }
    }
    parent.replaceChild(frag, node);
  }

  if (!wordSpans.length) {
    if (onDone) onDone();
    return () => {};
  }

  let i = 0;
  let timer = null;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    if (i >= wordSpans.length) {
      if (onDone) onDone();
      return;
    }
    wordSpans[i].classList.add('tw-word--shown');
    i += 1;
    timer = setTimeout(tick, wordDelayMs);
  };
  tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    for (const s of wordSpans) s.classList.add('tw-word--shown');
  };
}
