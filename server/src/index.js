import http from 'http';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { initDb } from './db/index.js';
import { initWs } from './ws/index.js';
import authRoutes from './routes/auth.js';
import notesRoutes from './routes/notes.js';
import importRoutes from './routes/import.js';
import dissectRoutes from './routes/dissect.js';
import notebooksRoutes from './routes/notebooks.js';
import adminRoutes from './routes/admin.js';
import templatesRoutes from './routes/templates.js';
import { cleanupOrphanFts } from './services/indexService.js';
import { reapStalledJobs } from './services/jobService.js';

// Fail fast if required environment variables are missing
const REQUIRED_ENV = ['JWT_ACCESS_SECRET', 'JWT_ACCESS_EXPIRES', 'JWT_REFRESH_EXPIRES', 'VAULT_ROOT', 'DB_PATH', 'UPLOAD_TMP'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

initDb(process.env.DB_PATH);
cleanupOrphanFts();
reapStalledJobs();

const app = express();

app.set('trust proxy', 1); // nginx sits in front

app.use(helmet({
  // CSP must be configured at the nginx level for the frontend HTML file;
  // disabling here to avoid breaking the API-only responses with an overly
  // restrictive policy that doesn't match what the frontend actually needs.
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Global rate limit — tightened per-route where needed
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Auth registration gets its own strict limiter (relaxed in dev)
const isDev = process.env.NODE_ENV !== 'production';
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 1000 : 20,
});
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/login', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/import', importRoutes);
app.use('/api/dissect', dissectRoutes);
app.use('/api/notebooks', notebooksRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/templates', templatesRoutes);

app.use((err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) {
    console.error(err);
    return res.status(status).json({ error: 'Internal server error' });
  }
  res.status(status).json({ error: err.message ?? 'Internal server error' });
});

const server = http.createServer(app);
initWs(server);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
