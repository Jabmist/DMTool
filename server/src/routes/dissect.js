import { Router } from 'express';
import path from 'path';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { requireAuth } from '../middleware/auth.js';
import { cancelDissectJob, continueDissectJob, createJob, getJob, runDissectJob } from '../services/jobService.js';
import { warmModel } from '../services/aiService.js';
import { writeNote, appendToNote } from '../services/fileService.js';
import { indexNote } from '../services/indexService.js';
import { broadcast } from '../ws/index.js';
import { getDb } from '../db/index.js';

const router = Router();
router.use(requireAuth);

const isDev = process.env.NODE_ENV !== 'production';

const dissectLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user.sub),
});

const warmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user.sub),
});

const approveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user.sub),
});

const MAX_NOTES_PER_APPROVE = 100;

const ALLOWED_UPLOAD_EXT = new Set(['.txt', '.md', '.pdf', '.docx']);

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB — PDFs can be large
  fileFilter(_req, file, cb) {
    cb(null, ALLOWED_UPLOAD_EXT.has(path.extname(file.originalname).toLowerCase()));
  },
});

async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: file.buffer });
    const result = await parser.getText();
    return result.text;
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  return file.buffer.toString('utf8');
}
// Allow printable ASCII except path separators and control characters; max 200 chars
const TITLE_RE = /^[^/\\<>:"|?*\x00-\x1f]{1,200}$/;

// Create a notebook that owns the given note paths, named after the summary
// note's title. On a name collision, append a number (…2, …3, …) until the
// name is free for this user. The UNIQUE(user_id, name) constraint is the
// final guard — a concurrent insert slipping through the check throws, and the
// caller reports notebook creation as failed.
function createNotebookForSet(db, userId, baseName, notePaths) {
  const nameTaken = name => db
    .prepare('SELECT 1 FROM notebooks WHERE user_id = ? AND name = ?')
    .get(userId, name) !== undefined;

  let name = baseName;
  for (let i = 2; nameTaken(name); i++) name = `${baseName} ${i}`;

  const res = db
    .prepare('INSERT INTO notebooks (user_id, name) VALUES (?, ?)')
    .run(userId, name);
  const notebookId = Number(res.lastInsertRowid);

  const addNote = db.prepare('INSERT OR IGNORE INTO notebook_notes (notebook_id, user_id, note_path) VALUES (?, ?, ?)');
  for (const p of notePaths) addNote.run(notebookId, userId, p);

  return { id: notebookId, name, paths: notePaths };
}

// POST /api/dissect/warm — preload (warm up) the model.
// Must be registered BEFORE the /:jobId routes so 'warm' is not parsed as a jobId.
router.post('/warm', warmLimiter, async (req, res) => {
  const result = await warmModel();
  res.status(200).json(result);
});

// POST /api/dissect — submit raw text, get back a jobId immediately
router.post('/', dissectLimiter, async (req, res) => {
  const { text } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });

  const jobId = createJob(req.user.sub, 'dissect', text);
  // Fire and forget — client watches for job:preview via WebSocket
  runDissectJob(jobId, req.user.sub, text).catch(() => {});
  res.status(202).json({ jobId });
});

// GET /api/dissect/:jobId — poll job status (fallback for clients without WS)
router.get('/:jobId', (req, res) => {
  const job = getJob(req.params.jobId, req.user.sub);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const result = job.result ? JSON.parse(job.result) : null;
  res.json({ ...job, result });
});

// POST /api/dissect/:jobId/approve — write approved notes to vault
router.post('/:jobId/approve', approveLimiter, async (req, res) => {
  const job = getJob(req.params.jobId, req.user.sub);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'preview') return res.status(409).json({ error: 'Job is not in preview state' });

  // approvedNotes: [{ title, content }] — client may have edited them
  const { notes: approvedNotes } = req.body ?? {};
  if (!Array.isArray(approvedNotes) || approvedNotes.length === 0) {
    return res.status(400).json({ error: 'notes array required' });
  }
  if (approvedNotes.length > MAX_NOTES_PER_APPROVE) {
    return res.status(400).json({ error: `Cannot approve more than ${MAX_NOTES_PER_APPROVE} notes at once` });
  }

  const db = getDb();
  const uid = req.user.sub;
  db.prepare("UPDATE jobs SET status = 'approved', updated_at = unixepoch() WHERE id = ?").run(job.id);

  const written = [];
  const writtenNotes = []; // { path, title, isSummary }
  const errors = [];

  for (const note of approvedNotes) {
    const { title, content } = note;
    if (!title || content === undefined) { errors.push({ title, error: 'missing fields' }); continue; }
    if (!TITLE_RE.test(title)) { errors.push({ title, error: 'invalid title' }); continue; }

    // Strip any trailing .md to avoid double extension
    const cleanTitle = title.replace(/\.md$/i, '');
    const notePath = `${cleanTitle}.md`;
    try {
      const exists = db.prepare('SELECT 1 FROM notes WHERE user_id = ? AND title = ?').get(uid, cleanTitle);
      if (exists) {
        await appendToNote(uid, notePath, content);
      } else {
        await writeNote(uid, notePath, content);
      }
      await indexNote(uid, notePath);
      written.push(notePath);
      writtenNotes.push({ path: notePath, title: cleanTitle, isSummary: note.isSummary === true });
    } catch (e) {
      errors.push({ title, error: 'Write failed' });
    }
  }

  // Group a multi-note approval into a notebook named after the summary note.
  let notebook = null;
  if (writtenNotes.length >= 2) {
    const summary = writtenNotes.find(n => n.isSummary);
    if (summary) {
      try {
        notebook = createNotebookForSet(db, uid, summary.title, writtenNotes.map(n => n.path));
      } catch (e) {
        console.error(e);
        errors.push({ error: 'Notebook creation failed' });
      }
    }
  }

  db.prepare("UPDATE jobs SET status = 'complete', updated_at = unixepoch() WHERE id = ?").run(job.id);
  broadcast(uid, { type: 'job:complete', jobId: job.id, written, errors, notebook });

  res.json({ written, errors, notebook });
});

// POST /api/dissect/:jobId/cancel — interrupt the dissection (processing or waiting)
router.post('/:jobId/cancel', (req, res) => {
  const job = getJob(req.params.jobId, req.user.sub);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!['processing', 'waiting_continue'].includes(job.status)) {
    return res.status(409).json({ error: `Job is not running (status: ${job.status})` });
  }
  cancelDissectJob(job.id);
  // Status flip + WS notification happen in the worker as soon as the turn aborts
  res.status(202).json({ cancelling: true });
});

// POST /api/dissect/:jobId/continue — keep the dissection going after a timeout
router.post('/:jobId/continue', (req, res) => {
  const job = getJob(req.params.jobId, req.user.sub);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'waiting_continue') {
    return res.status(409).json({ error: `Job is not waiting (status: ${job.status})` });
  }
  if (!continueDissectJob(job.id)) {
    return res.status(409).json({ error: 'Job is no longer active' });
  }
  res.status(202).json({ continuing: true });
});

// POST /api/dissect/upload — upload a .txt, .md, .pdf, or .docx file to dissect
router.post('/upload', dissectLimiter, (req, res, next) => {
  fileUpload.single('file')(req, res, async err => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'file required (.txt, .md, .pdf, or .docx)' });
    let text;
    try {
      text = (await extractText(req.file)).trim();
    } catch (e) {
      return res.status(400).json({ error: `Could not extract text: ${e.message}` });
    }
    if (!text) return res.status(400).json({ error: 'file is empty or contains no extractable text' });
    const jobId = createJob(req.user.sub, 'dissect', text);
    runDissectJob(jobId, req.user.sub, text).catch(() => {});
    res.status(202).json({ jobId });
  });
});

export default router;
