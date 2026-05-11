/**
 * ui/evidence.js — Evidence Used panel
 *
 * Used ONLY by Ask the Analyst (page-level) and Methodology (static list).
 * Removed from Atlas / Sport / Parity / Compare per product spec.
 *
 * Evidence record shape (current, from helpers/evidenceModel.js):
 *   { files: string[], fields: string[], rowCount: number, notes: string[] }
 *
 * For each record the renderer surfaces the first file as the heading and
 * joins additional files / notes inline. Most analyst chips emit one file
 * per record, so the visible output is identical to the prior per-file shape.
 */

function pickFile(e) {
  if (Array.isArray(e.files) && e.files.length) return e.files[0];
  return e.file || '';
}
function pickExtraFiles(e) {
  if (Array.isArray(e.files) && e.files.length > 1) return e.files.slice(1);
  return [];
}
function pickNote(e) {
  if (Array.isArray(e.notes) && e.notes.length) return e.notes.join(' ');
  return e.note || '';
}
function pickFields(e) {
  return Array.isArray(e.fields) ? e.fields : [];
}

export function renderEvidencePanel(host, evidenceList = []) {
  if (!host) return;
  if (!evidenceList.length) {
    host.innerHTML = '<div class="evidence-empty">No evidence yet.</div>';
    return;
  }
  host.innerHTML = `
    <div class="evidence-list">
      ${evidenceList.map((e) => {
        const file = pickFile(e);
        const extras = pickExtraFiles(e);
        const note = pickNote(e);
        const fields = pickFields(e);
        return `
        <div class="evidence-row">
          <div class="evidence-file"><code>${file}</code>${extras.length ? ' ' + extras.map((f) => `<code>${f}</code>`).join(' ') : ''}${e.rowCount != null ? `<span class="evidence-rows"> · ${e.rowCount.toLocaleString()} rows</span>` : ''}</div>
          ${fields.length ? `<div class="evidence-fields">${fields.map((f) => `<code>${f}</code>`).join(' ')}</div>` : ''}
          ${note ? `<div class="evidence-note">${note}</div>` : ''}
        </div>
      `;
      }).join('')}
    </div>
  `;
}
