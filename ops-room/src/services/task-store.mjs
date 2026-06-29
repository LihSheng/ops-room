import { readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_DIR, STATE_DIR, PROCESSED_TASKS_FILE, LOCK_DIR, WORKSPACE_BASE, LOG_DIR, PROMPT_DIR } from './runtime-paths.mjs';

export async function loadProcessedTasks() {
  try {
    const raw = await readFile(PROCESSED_TASKS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function markTaskProcessed(taskId) {
  const tasks = await loadProcessedTasks();
  if (!tasks.includes(taskId)) {
    tasks.push(taskId);
    await writeFile(PROCESSED_TASKS_FILE, JSON.stringify(tasks, null, 2));
  }
}

export function lockPath(ctx) {
  return join(LOCK_DIR, `issue-${ctx.issueNumber}-${ctx.agent}.lock`);
}

export function acquireLock(ctx) {
  const lp = lockPath(ctx);
  if (existsSync(lp)) return false;
  writeFileSync(lp, String(process.pid));
  return true;
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
