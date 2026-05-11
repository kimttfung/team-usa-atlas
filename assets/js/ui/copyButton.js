/**
 * ui/copyButton.js — clipboard-copy button.
 *
 * Pure ES module. Two exports:
 *
 *   createCopyButton({ getText, label, onCopy }) -> HTMLButtonElement
 *     Returns a standalone <button> you can append anywhere. Clicking it
 *     calls getText() (sync or async), writes the result to the clipboard,
 *     and flashes a transient "Copied" microtext next to the icon.
 *
 *   attachCopyButton(targetEl, getText, opts) -> HTMLButtonElement | null
 *     Mounts a copy button onto targetEl. If a previous copy button
 *     already lives in targetEl (marked with data-copy-btn="true"),
 *     it's removed first so re-renders don't stack duplicates. Returns
 *     the button (or null if targetEl is missing).
 *
 * Uses navigator.clipboard.writeText() when available, with a textarea +
 * document.execCommand('copy') fallback for older browsers.
 */

const FEEDBACK_MS = 1500;

const ICON_SVG = `
<svg class="copy-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
     width="14" height="14" aria-hidden="true" focusable="false">
  <rect x="9" y="9" width="11" height="11" rx="2"/>
  <path d="M5 15V6a2 2 0 0 1 2-2h9"/>
</svg>`.trim();

const CHECK_SVG = `
<svg class="copy-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
     width="14" height="14" aria-hidden="true" focusable="false">
  <path d="M20 6 9 17l-5-5"/>
</svg>`.trim();

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (_e) {
    return false;
  }
}

async function writeClipboard(text) {
  if (typeof text !== 'string' || !text) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_e) {
      // fall through to legacy path
    }
  }
  return fallbackCopy(text);
}

export function createCopyButton({ getText, label = 'Copy', onCopy } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.setAttribute('aria-label', 'Copy insight to clipboard');
  btn.setAttribute('title', label);
  btn.dataset.copyBtn = 'true';
  btn.innerHTML = `${ICON_SVG}<span class="copy-btn__feedback" aria-hidden="true"></span>`;

  let timer = null;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    let text = '';
    try {
      const raw = typeof getText === 'function' ? getText() : '';
      text = raw && typeof raw.then === 'function' ? await raw : raw;
    } catch (_err) {
      text = '';
    }
    if (typeof text !== 'string') text = String(text || '');
    if (!text.trim()) return;

    const ok = await writeClipboard(text);
    if (!ok) return;

    btn.classList.add('is-copied');
    const icon = btn.querySelector('.copy-btn__icon');
    const fb = btn.querySelector('.copy-btn__feedback');
    if (icon) icon.outerHTML = CHECK_SVG;
    if (fb) fb.textContent = 'Copied';
    btn.setAttribute('aria-label', 'Copied to clipboard');

    if (typeof onCopy === 'function') {
      try { onCopy(text); } catch (_e) { /* noop */ }
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove('is-copied');
      const cur = btn.querySelector('.copy-btn__icon');
      if (cur) cur.outerHTML = ICON_SVG;
      const fb2 = btn.querySelector('.copy-btn__feedback');
      if (fb2) fb2.textContent = '';
      btn.setAttribute('aria-label', 'Copy insight to clipboard');
      timer = null;
    }, FEEDBACK_MS);
  });

  return btn;
}

export function attachCopyButton(targetEl, getText, opts = {}) {
  if (!targetEl) return null;
  // Strip any previous instance so re-renders don't stack duplicates.
  const prev = targetEl.querySelector(':scope > [data-copy-btn="true"]');
  if (prev) prev.remove();
  const btn = createCopyButton({ getText, ...opts });
  // Default to a host class so CSS can position absolutely without callers
  // having to remember to add it.
  if (!targetEl.classList.contains('has-copy-btn')) {
    targetEl.classList.add('has-copy-btn');
  }
  targetEl.appendChild(btn);
  return btn;
}

/**
 * Convert a chunk of HTML to plain text suitable for clipboard paste.
 * Preserves rough line structure: block elements and <br> become newlines,
 * list items get a "- " prefix, table rows are tab-joined.
 */
export function htmlToPlainText(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = String(html);

  const BLOCK = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TR']);
  const lines = [];
  let buf = '';

  const flush = () => {
    const t = buf.replace(/[ \t]+/g, ' ').trim();
    if (t) lines.push(t);
    buf = '';
  };

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buf += node.nodeValue;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    if (tag === 'BR') { flush(); return; }
    if (tag === 'LI') {
      flush();
      buf += '- ';
      for (const c of node.childNodes) walk(c);
      flush();
      return;
    }
    if (tag === 'TR') {
      const cells = [];
      for (const c of node.children) cells.push((c.textContent || '').trim());
      flush();
      if (cells.some(Boolean)) lines.push(cells.join('\t'));
      return;
    }
    if (tag === 'A') {
      // Preserve link href in plain-text output so pasted insights keep their
      // citations. Skip empty/anchor-only hrefs to avoid noise.
      const href = (node.getAttribute('href') || '').trim();
      const txt = (node.textContent || '').trim();
      if (href && txt && href !== txt && !href.startsWith('#') && !href.startsWith('javascript:')) {
        buf += `${txt} (${href})`;
      } else {
        for (const c of node.childNodes) walk(c);
      }
      return;
    }
    if (BLOCK.has(tag)) {
      flush();
      for (const c of node.childNodes) walk(c);
      flush();
      return;
    }
    for (const c of node.childNodes) walk(c);
  };

  walk(tmp);
  flush();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
