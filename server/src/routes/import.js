import { Router } from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { requireAuth } from '../middleware/auth.js';
import { writeNote, appendToNote, safePath } from '../services/fileService.js';
import { indexNote } from '../services/indexService.js';
import { getDb } from '../db/index.js';

const router = Router();
router.use(requireAuth);

const ALLOWED_EXT = new Set(['.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per upload

const upload = multer({
  dest: process.env.UPLOAD_TMP,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_EXT.has(ext) || file.mimetype === 'application/zip');
  },
});

const VALID_CONFLICT_MODES = new Set(['overwrite', 'append', 'skip']);

// Verify the first 4 bytes match the ZIP magic number (PK\x03\x04)
async function isZipFile(filePath) {
  let fd;
  try {
    fd = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 0);
    return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  } catch {
    return false;
  } finally {
    await fd?.close();
  }
}

// Validate that a zip entry path has no traversal components
function safeZipEntry(entryName) {
  const normalized = path.normalize(entryName);
  return !normalized.startsWith('..') && !path.isAbsolute(normalized);
}

async function importFiles(userId, files, conflictMode) {
  const written = [], skipped = [], errors = [];

  for (const { notePath, tmpPath, isMd } of files) {
    try {
      if (isMd) {
        const db = getDb();
        const title = path.basename(notePath, '.md');
        const exists = db.prepare('SELECT 1 FROM notes WHERE user_id = ? AND path = ?').get(userId, notePath);

        if (exists && conflictMode === 'skip') { skipped.push(notePath); continue; }
        if (exists && conflictMode === 'append') {
          const incoming = await fs.readFile(tmpPath, 'utf8');
          await appendToNote(userId, notePath, incoming);
        } else {
          const content = await fs.readFile(tmpPath, 'utf8');
          await writeNote(userId, notePath, content);
        }
        await indexNote(userId, notePath);
      } else {
        // Attachment: copy into vault preserving path
        const dest = safePath(userId, notePath);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(tmpPath, dest);
      }
      written.push(notePath);
    } catch (e) {
      errors.push({ path: notePath, error: e.message });
    }
  }
  return { written, skipped, errors };
}

// POST /api/import/file — single .md file
router.post('/file', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const conflictMode = req.body.conflict ?? 'overwrite';
  if (!VALID_CONFLICT_MODES.has(conflictMode)) return res.status(400).json({ error: 'conflict must be overwrite, append, or skip' });
  const notePath = path.basename(req.file.originalname);

  try {
    const result = await importFiles(req.user.sub, [{
      notePath,
      tmpPath: req.file.path,
      isMd: true,
    }], conflictMode);
    res.json(result);
  } finally {
    fs.unlink(req.file.path).catch(() => {});
  }
});

// POST /api/import/vault — zip archive of vault
router.post('/vault', upload.single('vault'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const conflictMode = req.body.conflict ?? 'overwrite';
  if (!VALID_CONFLICT_MODES.has(conflictMode)) return res.status(400).json({ error: 'conflict must be overwrite, append, or skip' });

  const tmpDir = path.join(process.env.UPLOAD_TMP, crypto.randomUUID());
  try {
    if (!await isZipFile(req.file.path)) {
      return res.status(400).json({ error: 'Uploaded file is not a valid ZIP archive' });
    }
    await fs.mkdir(tmpDir, { recursive: true });
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!safeZipEntry(entry.entryName)) continue; // reject path traversal
      if (entry.entryName.startsWith('.obsidian/')) continue; // skip vault config

      const ext = path.extname(entry.entryName).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;

      const destPath = path.join(tmpDir, entry.entryName);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, entry.getData());
      files.push({ notePath: entry.entryName, tmpPath: destPath, isMd: ext === '.md' });
    }

    const result = await importFiles(req.user.sub, files, conflictMode);
    res.json(result);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    fs.unlink(req.file.path).catch(() => {});
  }
});

// Allow printable ASCII except path separators and control characters; max 200 chars
const FILENAME_RE = /^[^/\\<>:"|?*\x00-\x1f]{1,200}$/;

function sanitizeFilename(raw) {
  return raw.trim().replace(/[/\\<>:"|?*\x00-\x1f]/g, '-').slice(0, 200) || 'imported';
}

function isPrivateHost(hostname) {
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;
  return [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^fc00:/i,
    /^fe80:/i,
  ].some(re => re.test(hostname));
}

async function saveImportedNote(userId, notePath, content, conflictMode) {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM notes WHERE user_id = ? AND path = ?').get(userId, notePath);
  if (exists && conflictMode === 'skip') return { written: [], skipped: [notePath], errors: [] };
  if (exists && conflictMode === 'append') {
    await appendToNote(userId, notePath, content);
  } else {
    await writeNote(userId, notePath, content);
  }
  await indexNote(userId, notePath);
  return { written: [notePath], skipped: [], errors: [] };
}

// POST /api/import/text — paste plain text, save as a markdown note
router.post('/text', async (req, res) => {
  const { text, filename, conflict = 'overwrite' } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  if (!filename?.trim()) return res.status(400).json({ error: 'filename required' });
  if (!VALID_CONFLICT_MODES.has(conflict)) return res.status(400).json({ error: 'conflict must be overwrite, append, or skip' });

  const baseName = filename.replace(/\.md$/i, '').trim();
  if (!FILENAME_RE.test(baseName)) return res.status(400).json({ error: 'invalid filename' });
  const notePath = `${baseName}.md`;

  try {
    res.json(await saveImportedNote(req.user.sub, notePath, text, conflict));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/import/url — fetch a URL and convert HTML to markdown
router.post('/url', async (req, res) => {
  const { url, filename, conflict = 'overwrite' } = req.body ?? {};
  if (!url?.trim()) return res.status(400).json({ error: 'url required' });
  if (!VALID_CONFLICT_MODES.has(conflict)) return res.status(400).json({ error: 'conflict must be overwrite, append, or skip' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'URL must use http or https' });
  if (isPrivateHost(parsed.hostname)) return res.status(400).json({ error: 'URL resolves to a private or internal host' });

  // Fetch with timeout and 5 MB cap
  let html;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ObsidianWeb/1.0)' },
    });
    if (!resp.ok) return res.status(400).json({ error: `Fetch failed: ${resp.status} ${resp.statusText}` });
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) return res.status(400).json({ error: 'URL did not return an HTML page' });

    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 5 * 1024 * 1024) return res.status(400).json({ error: 'Page exceeds 5 MB size limit' });
      chunks.push(value);
    }
    html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  } catch (e) {
    return res.status(400).json({ error: `Could not fetch URL: ${e.message}` });
  }

  // Extract article content and convert to markdown
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article) return res.status(400).json({ error: 'Could not extract readable content from URL' });

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = `# ${article.title}\n\n> Source: ${url}\n\n${td.turndown(article.content)}`;

  const baseName = filename?.trim()
    ? filename.replace(/\.md$/i, '').trim()
    : sanitizeFilename(article.title);
  if (!FILENAME_RE.test(baseName)) return res.status(400).json({ error: 'invalid filename' });
  const notePath = `${baseName}.md`;

  try {
    res.json(await saveImportedNote(req.user.sub, notePath, markdown, conflict));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
