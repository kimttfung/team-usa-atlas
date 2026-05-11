/**
 * server/index.js — Express bootstrap.
 *
 * Single-process server that:
 *   1. Hosts every static file under the repo root (so `/`, `/app.html`,
 *      `/assets/*`, `/data/*` keep working exactly as they did under
 *      `serve`).
 *   2. Exposes `POST /api/gemini/generate` for the frontend Gemini
 *      client (`assets/js/lib/gemini.js`).
 *
 * The Gemini API key lives in `process.env.GEMINI_API_KEY` (loaded from
 * `.env` via `dotenv`) and is never sent to the browser.
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { generate } from './geminiClient.js';
import { validateGeminiResult } from './validate.js';
import { VALID_TASKS } from './schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, '..');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.post('/api/gemini/generate', async (req, res) => {
  const started = Date.now();
  const { task, question = null, context = {} } = req.body || {};

  if (!task || !VALID_TASKS.includes(task)) {
    res.json({ ok: false, source: 'fallback', error: 'bad_task', flags: [`task=${task}`] });
    return;
  }

  let parsed;
  try {
    parsed = await generate({ task, question, context });
  } catch (err) {
    const code = err?.code || 'gemini_error';
    const ms = Date.now() - started;
    console.warn(`[gemini] task=${task} ok=false ms=${ms} error=${code}`);
    if (process.env.GEMINI_DEBUG) console.warn(err);
    res.json({ ok: false, source: 'fallback', error: code });
    return;
  }

  const validation = validateGeminiResult(parsed, task);
  const ms = Date.now() - started;
  if (!validation.ok) {
    console.warn(`[gemini] task=${task} ok=false ms=${ms} flags=${validation.flags.join(',')}`);
    res.json({ ok: false, source: 'fallback', error: 'validation_failed', flags: validation.flags });
    return;
  }

  console.log(`[gemini] task=${task} ok=true ms=${ms}`);
  res.json({ ok: true, source: 'gemini', task, result: parsed });
});

// Convenience health probe so deploy targets and scripts can verify the
// server is up without sending Gemini traffic.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.GEMINI_API_KEY),
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// Serve `/` as `app.html` so the legacy URL keeps working.
app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'app.html'));
});

// Static handler for everything else (assets, data, etc.).
app.use(express.static(ROOT_DIR, {
  index: false,
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.json')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8000;
app.listen(PORT, () => {
  const keyStatus = process.env.GEMINI_API_KEY ? 'loaded' : 'MISSING (Gemini calls will fall back)';
  const model     = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  console.log(`Team USA Atlas — http://localhost:${PORT}`);
  console.log(`  Gemini key: ${keyStatus}`);
  console.log(`  Gemini model: ${model}`);
});
