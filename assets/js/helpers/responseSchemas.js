/**
 * helpers/responseSchemas.js
 *
 * JSDoc-typed factory functions for the response shapes that Gemini (and
 * the current deterministic templates) produce. Each factory defaults
 * missing fields to safe empty values, validates the title, and freezes
 * the returned object so consumers can treat it as immutable.
 *
 * Compact, JSON-serializable response envelopes for future Gemini integration.
 */

/**
 * @typedef {Object} EvidenceModel
 * @property {Array<{ name: string, rowsUsed: number, fields: string[] }>} files
 * @property {string[]} notes
 */

/**
 * @typedef {Object} RegionalBrief
 * @property {string} title
 * @property {string[]} bullets
 * @property {string} caveat
 * @property {string[]} followUps
 */

/**
 * @typedef {Object} AskAnswer
 * @property {string} title
 * @property {string[]} bullets
 * @property {{ columns: string[], rows: object[] }} table
 * @property {EvidenceModel} evidence
 * @property {string} caveat
 * @property {string[]} followUps
 */

/**
 * @typedef {Object} CompareBrief
 * @property {string} title
 * @property {string[]} similarities
 * @property {string[]} differences
 * @property {string} mostDistinctContrast
 * @property {string} caveat
 */

/**
 * @typedef {Object} SportBrief
 * @property {string} title
 * @property {string[]} bullets
 * @property {string} footprintType
 * @property {string} caveat
 * @property {string[]} followUps
 */

/**
 * @typedef {Object} ParityBrief
 * @property {string} title
 * @property {string[]} bullets
 * @property {string} caveat
 * @property {string[]} followUps
 */

/** @type {EvidenceModel} */
export const EMPTY_EVIDENCE = Object.freeze({ files: [], notes: [] });

function requireTitle(title, fnName) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error(`${fnName}: \`title\` is required and must be a non-empty string.`);
  }
}

function arr(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Partial<RegionalBrief>} input
 * @returns {RegionalBrief}
 */
export function makeRegionalBrief({ title, bullets, caveat, followUps } = {}) {
  requireTitle(title, 'makeRegionalBrief');
  return Object.freeze({
    title,
    bullets: arr(bullets),
    caveat: str(caveat),
    followUps: arr(followUps),
  });
}

/**
 * @param {Partial<AskAnswer>} input
 * @returns {AskAnswer}
 */
export function makeAskAnswer({ title, bullets, table, evidence, caveat, followUps } = {}) {
  requireTitle(title, 'makeAskAnswer');
  const safeTable = (table && typeof table === 'object')
    ? { columns: arr(table.columns), rows: arr(table.rows) }
    : { columns: [], rows: [] };
  const safeEvidence = evidence && typeof evidence === 'object'
    ? { files: evidence.files, notes: evidence.notes }
    : { files: [], notes: [] };
  if (!Array.isArray(safeEvidence.files)) {
    throw new Error('makeAskAnswer: `evidence.files` must be an array.');
  }
  return Object.freeze({
    title,
    bullets: arr(bullets),
    table: Object.freeze(safeTable),
    evidence: Object.freeze({
      files: safeEvidence.files.slice(),
      notes: arr(safeEvidence.notes),
    }),
    caveat: str(caveat),
    followUps: arr(followUps),
  });
}

/**
 * @param {Partial<CompareBrief>} input
 * @returns {CompareBrief}
 */
export function makeCompareBrief({ title, similarities, differences, mostDistinctContrast, caveat } = {}) {
  requireTitle(title, 'makeCompareBrief');
  return Object.freeze({
    title,
    similarities: arr(similarities),
    differences: arr(differences),
    mostDistinctContrast: str(mostDistinctContrast),
    caveat: str(caveat),
  });
}

/**
 * @param {Partial<SportBrief>} input
 * @returns {SportBrief}
 */
export function makeSportBrief({ title, bullets, footprintType, caveat, followUps } = {}) {
  requireTitle(title, 'makeSportBrief');
  return Object.freeze({
    title,
    bullets: arr(bullets),
    footprintType: str(footprintType),
    caveat: str(caveat),
    followUps: arr(followUps),
  });
}

/**
 * @param {Partial<ParityBrief>} input
 * @returns {ParityBrief}
 */
export function makeParityBrief({ title, bullets, caveat, followUps } = {}) {
  requireTitle(title, 'makeParityBrief');
  return Object.freeze({
    title,
    bullets: arr(bullets),
    caveat: str(caveat),
    followUps: arr(followUps),
  });
}
