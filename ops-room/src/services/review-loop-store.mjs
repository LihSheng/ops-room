import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, utcTimestamp } from './runtime-paths.mjs';

const REVIEW_LOOP_DIR = join(DATA_DIR, 'ops-room', 'review-loop');

export async function ensureReviewLoopDir() {
  try { await mkdir(REVIEW_LOOP_DIR, { recursive: true }); } catch { }
}

function loopStateFile(repo, pr) {
  const safeRepo = String(repo || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return join(REVIEW_LOOP_DIR, `loop-${safeRepo}-pr-${pr}.json`);
}

function loopLockFile(repo, pr) {
  const safeRepo = String(repo || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return join(REVIEW_LOOP_DIR, `loop-${safeRepo}-pr-${pr}.lock`);
}

/**
 * Get the current review loop state for a PR.
 * Returns null if no loop state exists.
 */
export async function getReviewLoopState(repo, pr) {
  try {
    const raw = await readFile(loopStateFile(repo, pr), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Create or update review loop state for a PR.
 * State shape:
 * {
 *   repo: string,
 *   pr: number,
 *   agent: string,           // The review agent (e.g. 'professor')
 *   fixAgent: string,        // The coding agent doing fixes (e.g. 'berlin')
 *   iteration: number,       // Current iteration (0 = first review)
 *   status: 'reviewing' | 'fixing' | 'approved' | 'escalated' | 'failed',
 *   history: Array<{ iteration, event, summary, timestamp }>,
 *   startedAt: string,
 *   updatedAt: string,
 * }
 */
export async function updateReviewLoopState(repo, pr, updates) {
  await ensureReviewLoopDir();
  const current = await getReviewLoopState(repo, pr) || {
    repo,
    pr: Number(pr),
    agent: 'professor',
    fixAgent: 'berlin',
    iteration: 0,
    status: 'reviewing',
    history: [],
    startedAt: utcTimestamp(),
  };

  const updated = {
    ...current,
    ...updates,
    updatedAt: utcTimestamp(),
  };

  await writeFile(loopStateFile(repo, pr), JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * Increment the iteration counter and add a history entry.
 * Returns the updated state.
 */
export async function advanceLoopIteration(repo, pr, historyEntry) {
  const state = await getReviewLoopState(repo, pr) || {
    repo,
    pr: Number(pr),
    agent: 'professor',
    fixAgent: 'berlin',
    iteration: 0,
    status: 'reviewing',
    history: [],
    startedAt: utcTimestamp(),
  };

  state.iteration = (state.iteration || 0) + 1;
  state.history.push({
    iteration: state.iteration,
    ...historyEntry,
    timestamp: utcTimestamp(),
  });
  state.updatedAt = utcTimestamp();

  await writeFile(loopStateFile(repo, pr), JSON.stringify(state, null, 2));
  return state;
}

/**
 * Check if the loop has exceeded the maximum allowed iterations.
 */
export async function isLoopExhausted(repo, pr, maxIterations = 3) {
  const state = await getReviewLoopState(repo, pr);
  if (!state) return false;
  return (state.iteration || 0) >= maxIterations;
}

/**
 * Acquire a lock for the review loop on a PR.
 * Returns true if lock was acquired, false if already locked.
 */
export async function acquireReviewLoopLock(repo, pr) {
  try {
    const lockFile = loopLockFile(repo, pr);
    await writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now(),
    }), { flag: 'wx' });
    return true;
  } catch {
    // Check if lock is stale (older than 30 minutes)
    try {
      const lockFile = loopLockFile(repo, pr);
      const raw = await readFile(lockFile, 'utf-8');
      const data = JSON.parse(raw);
      if (Date.now() - data.acquiredAt > 30 * 60 * 1000) {
        // Stale lock — break it
        await rm(lockFile, { force: true });
        return await acquireReviewLoopLock(repo, pr);
      }
    } catch { }
    return false;
  }
}

/**
 * Release the review loop lock for a PR.
 */
export async function releaseReviewLoopLock(repo, pr) {
  try {
    await rm(loopLockFile(repo, pr), { force: true });
  } catch { }
}

export default {
  ensureReviewLoopDir,
  getReviewLoopState,
  updateReviewLoopState,
  advanceLoopIteration,
  isLoopExhausted,
  acquireReviewLoopLock,
  releaseReviewLoopLock,
};
