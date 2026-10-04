import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../db/index.js';

export function setTestEnv() {
  process.env.JWT_ACCESS_SECRET  = 'test-access-secret-at-least-32ch!';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32ch';
  process.env.JWT_ACCESS_EXPIRES  = '900';
  process.env.JWT_REFRESH_EXPIRES = '604800';
  process.env.UPLOAD_TMP = os.tmpdir();
}

export async function makeTmpVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-test-'));
  process.env.VAULT_ROOT = dir;
  return dir;
}

export async function cleanupTmpVault(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export function setupDb() {
  setTestEnv();
  return initDb(':memory:');
}

export async function createTestApp() {
  setTestEnv();
  const tmpVault = await makeTmpVault();
  setupDb();

  const { default: authRoutes }      = await import('../routes/auth.js');
  const { default: notesRoutes }     = await import('../routes/notes.js');
  const { default: notebooksRoutes } = await import('../routes/notebooks.js');
  const { default: adminRoutes }     = await import('../routes/admin.js');
  const { default: templatesRoutes } = await import('../routes/templates.js');
  const { default: dissectRoutes }   = await import('../routes/dissect.js');
  const { default: importRoutes }    = await import('../routes/import.js');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth',      authRoutes);
  app.use('/api/notes',     notesRoutes);
  app.use('/api/notebooks', notebooksRoutes);
  app.use('/api/admin',     adminRoutes);
  app.use('/api/templates', templatesRoutes);
  app.use('/api/dissect',   dissectRoutes);
  app.use('/api/import',    importRoutes);

  return { app, tmpVault };
}
