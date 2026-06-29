import { readFile, writeFile, rm, mkdir, readdir, appendFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_DIR, STATE_DIR, LOCK_DIR, WORKSPACE_BASE, LOG_DIR, PROMPT_DIR } from './runtime-paths.mjs';

const PROCESSED_TASKS_LOG = join(STATE_DIR, 'processed-tasks.log');

export async function loadProcessedTasks() {
  try {
    const text = await readFile(PROCESSED_TASKS_LOG, 'utf-8');
    const ids = text.trim().split('\n').filter(Boolean);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export async function markTaskProcessed(taskId) {
  try {
    await appendFile(PROCESSED_TASKS_LOG, taskId + '\n');
  } catch {}
}

export async function compactProcessedTasks() {
  try {
    const ids = await loadProcessedTasks();
    await writeFile(PROCESSED_TASKS_LOG, ids.join('\n') + '\n');
  } catch {}
}

export function lockPath(ctx) {
  return join(LOCK_DIR, `issue-${ctx.issueNumber}-${ctx.agent}.lock`);
}

export function acquireLock(ctx) {
  try {
    writeFileSync(lockPath(ctx), JSON.stringify({ harnessPid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export async function releaseLock(ctx) {
  try { await rm(lockPath(ctx), { force: true }); } catch { }
}

export async function ensureDir(dir) {
  try { await mkdir(dir, { recursive: true }); } catch { }
}

export async function fileExists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

export async function initDirs() {
  await ensureDir(TASKS_DIR);
  await ensureDir(WORKSPACE_BASE);
  await ensureDir(LOG_DIR);
  await ensureDir(STATE_DIR);
  await ensureDir(LOCK_DIR);
  await ensureDir(PROMPT_DIR);
  await compactProcessedTasks();
}

export async function readTasksDir() {
  const files = await readdir(TASKS_DIR);
  const tasks = await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(async (file) => {
        try {
          const task = JSON.parse(await readFile(join(TASKS_DIR, file), 'utf-8'));
          return { ...task, file };
        } catch {
          return null;
        }
      })
  );
  return tasks.filter(Boolean);
}

export async function readTaskById(taskId) {
  const safeTaskId = String(taskId || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(safeTaskId)) return null;

  try {
    const raw = await readFile(join(TASKS_DIR, `${safeTaskId}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
