/**
 * helpers/evidenceModel.js — shared Evidence factory.
 *
 * Every analyst response (deterministic today, Gemini-routed later) emits its
 * evidence through `buildEvidence(...)` so the shape stays consistent across
 * Ask the Analyst and the Methodology "Evidence Used" panel.
 */

/**
 * @typedef {Object} Evidence
 * @property {string[]} files     // e.g. ['data/state_summary.json']
 * @property {string[]} fields    // e.g. ['total_athletes', 'paralympic_athletes']
 * @property {number}   rowCount  // number of rows considered
 * @property {string[]} notes     // e.g. ['Athletes counted once even if listed in multiple sports']
 */

function dedupeStrings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function coerceRowCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Build a single Evidence record. De-duplicates files / fields / notes,
 * coerces rowCount to a non-negative integer, and returns a frozen object.
 *
 * For backward compatibility with consumers that still read the legacy
 * single-file shape (pages/ask.js renders `e.file` / `e.note` directly),
 * the returned object also carries `file` (= files[0]) and `note`
 * (= notes joined). These aliases are non-authoritative; new code should
 * read from `files` / `notes`.
 *
 * @param {Partial<Evidence>} [input]
 * @returns {Readonly<Evidence & { file: string, note: string }>}
 */
export function buildEvidence({ files = [], fields = [], rowCount = 0, notes = [] } = {}) {
  const dedupFiles  = dedupeStrings(files);
  const dedupFields = dedupeStrings(fields);
  const dedupNotes  = dedupeStrings(notes);
  const safeRows    = coerceRowCount(rowCount);
  return Object.freeze({
    files:    Object.freeze(dedupFiles),
    fields:   Object.freeze(dedupFields),
    rowCount: safeRows,
    notes:    Object.freeze(dedupNotes),
    // Legacy aliases — see JSDoc.
    file: dedupFiles[0] || '',
    note: dedupNotes.join(' '),
  });
}
