/**
 * Team USA Atlas — light/dark theme controller
 *
 * Toggles data-theme="light|dark" on <html>, persists the choice in
 * localStorage under "atlas.theme", and updates the topbar label/icon.
 * Pulled into its own module so main.js stays small.
 */

const STORAGE_KEY = 'atlas.theme';

function applyTheme(theme, { persist = false } = {}) {
  document.documentElement.dataset.theme = theme;
  const lbl = document.getElementById('themeLbl');
  if (lbl) lbl.textContent = theme === 'dark' ? 'Dark mode' : 'Light mode';
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* sandboxed */ }
  }
}

function systemPreferredTheme() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch { /* matchMedia unavailable */ }
  return 'light';
}

export function initTheme() {
  let initial = systemPreferredTheme();
  let userOverride = false;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') {
      initial = saved;
      userOverride = true;
    }
  } catch { /* sandboxed */ }
  applyTheme(initial, { persist: userOverride });

  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e) => {
        try { if (localStorage.getItem(STORAGE_KEY)) return; } catch { /* sandboxed */ }
        applyTheme(e.matches ? 'dark' : 'light', { persist: false });
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    }
  } catch { /* sandboxed */ }

  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next, { persist: true });
    });
  }
}
