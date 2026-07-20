import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  assertPathWithinRoot,
  ensureRepositoryCache,
  repositoryCacheKey,
  repositoryCachePath,
  resolveRepositoryRevision,
  validateRepositoryId,
} from './repository-cache.js';
import { listWorkspaceRecords, writeWorkspaceRecord } from './workspace-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const execFileDefault = promisify(execFileCallback);
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;
const SAFE_BRANCH = /^(?!\/|.*(?:\.\.|\/\.|\.\/|\/\/|@\{|\\))[A-Za-z0-9._\/-]{1,240}(?<![./])$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const ACTIVE_STATES = new Set(['allocating', 'active', 'cleanup_requested', 'cleaning', 'held_for_investigation']);

function safeValue(value, field) {
  const normalized = String(value || '').trim();
  if (!SAFE_ID.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

async function runGit(execFile, args, options = {}) {
  try {
    const result = await execFile('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs || 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return String(result?.stdout || '').trim();
  } catch {
    throw new Error(options.errorCode || 'git_worktree_command_failed');
  }
}

async function countActive(records) {
  return records.filter((record) => ACTIVE_STATES.has(record.state)).length;
}

export async function allocateWorkspace({
  cacheRoot,
  workspaceRoot,
  recordRoot,
  lockRoot,
  repositoryId,
  remote,
  workspaceId,
  ownerAgent,
  taskId,
  mode,
  branch = null,
  revision = 'HEAD',
  maxActiveWorkspaces = 8,
  minimumFreeBytes = 0,
  getFreeBytes = async () => Number.MAX_SAFE_INTEGER,
  execFile = execFileDefault,
  now = () => new Date().toISOString(),
}) {
  const repoId = validateRepositoryId(repositoryId);
  const repoKey = repositoryCacheKey(repoId);
  const id = safeValue(workspaceId, 'workspace_id');
  const owner = safeValue(ownerAgent, 'owner_agent');
  const task = safeValue(taskId, 'task_id');
  if (!['branch', 'detached'].includes(mode)) throw new Error('invalid_workspace_mode');
  if (mode === 'branch' && !SAFE_BRANCH.test(String(branch || ''))) throw new Error('invalid_workspace_branch');
  if (mode === 'detached' && !SAFE_SHA.test(String(revision || ''))) throw new Error('detached_workspace_requires_exact_sha');

  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(recordRoot, { recursive: true }),
    mkdir(lockRoot, { recursive: true }),
  ]);

  return withWorkspaceLock({
    dir: lockRoot,
    name: `workspace-admin-${repoKey}`,
    execute: async () => {
      const records = await listWorkspaceRecords({ dir: recordRoot });
      if ((await countActive(records)) >= maxActiveWorkspaces) throw new Error('workspace_capacity_exceeded');
      if (await getFreeBytes(workspaceRoot) < minimumFreeBytes) throw new Error('workspace_low_disk');
      if (records.some((record) => record.workspace_id === id && ACTIVE_STATES.has(record.state))) {
        throw new Error('workspace_id_conflict');
      }
      if (mode === 'branch' && records.some((record) => (
        record.repository_id === repoId
        && record.mode === 'branch'
        && record.branch === branch
        && ACTIVE_STATES.has(record.state)
      ))) throw new Error('workspace_branch_owned');

      const relativePath = join(owner, id);
      const workspacePath = assertPathWithinRoot(workspaceRoot, join(workspaceRoot, relativePath));
      const cache = await ensureRepositoryCache({ cacheRoot, lockRoot, repositoryId: repoId, remote, execFile });
      const resolvedSha = await resolveRepositoryRevision({ cachePath: cache.cache_path, revision, execFile });

      const baseRecord = {
        workspace_id: id,
        owner_agent: owner,
        task_id: task,
        repository_id: repoId,
        mode,
        branch: mode === 'branch' ? branch : null,
        requested_sha: SAFE_SHA.test(revision) ? revision.toLowerCase() : null,
        resolved_sha: resolvedSha,
        relative_path: relativePath,
        state: 'allocating',
        hold_reason: null,
        last_error: null,
        created_at: now(),
        updated_at: now(),
      };
      await writeWorkspaceRecord({ dir: recordRoot, record: baseRecord, now });

      try {
        await mkdir(resolve(workspacePath, '..'), { recursive: true });
        const args = ['--git-dir', cache.cache_path, 'worktree', 'add'];
        if (mode === 'detached') args.push('--detach', workspacePath, resolvedSha);
        else args.push('-B', branch, workspacePath, resolvedSha);
        await runGit(execFile, args, { errorCode: 'workspace_allocation_failed' });
        return writeWorkspaceRecord({ dir: recordRoot, record: { ...baseRecord, state: 'active' }, now });
      } catch (error) {
        await writeWorkspaceRecord({
          dir: recordRoot,
          record: { ...baseRecord, state: 'failed', last_error: error.message || 'workspace_allocation_failed' },
          now,
        });
        throw error;
      }
    },
  });
}

export async function requestWorkspaceCleanup({ recordRoot, workspaceId, holdReason = null, now }) {
  const records = await listWorkspaceRecords({ dir: recordRoot });
  const current = records.find((record) => record.workspace_id === workspaceId);
  if (!current) throw new Error('workspace_not_found');
  if (current.state === 'held_for_investigation') throw new Error('workspace_held');
  if (holdReason) {
    return writeWorkspaceRecord({
      dir: recordRoot,
      record: { ...current, state: 'held_for_investigation', hold_reason: String(holdReason).slice(0, 300) },
      now,
    });
  }
  if (current.state !== 'active' && current.state !== 'failed') throw new Error('workspace_cleanup_not_allowed');
  return writeWorkspaceRecord({ dir: recordRoot, record: { ...current, state: 'cleanup_requested' }, now });
}

export async function cleanupWorkspace({
  cacheRoot,
  workspaceRoot,
  recordRoot,
  lockRoot,
  workspaceId,
  execFile = execFileDefault,
  now = () => new Date().toISOString(),
}) {
  return withWorkspaceLock({
    dir: lockRoot,
    name: `workspace-cleanup-${safeValue(workspaceId, 'workspace_id')}`,
    execute: async () => {
      const records = await listWorkspaceRecords({ dir: recordRoot });
      const current = records.find((record) => record.workspace_id === workspaceId);
      if (!current) throw new Error('workspace_not_found');
      if (current.state === 'released') return current;
      if (current.state !== 'cleanup_requested') throw new Error('workspace_cleanup_not_requested');
      const workspacePath = assertPathWithinRoot(workspaceRoot, join(workspaceRoot, current.relative_path));
      const cachePath = repositoryCachePath(cacheRoot, current.repository_id);
      await writeWorkspaceRecord({ dir: recordRoot, record: { ...current, state: 'cleaning' }, now });
      try {
        let exists = false;
        try { exists = (await stat(workspacePath)).isDirectory(); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (exists) {
          await runGit(execFile, ['--git-dir', cachePath, 'worktree', 'remove', '--force', workspacePath], {
            errorCode: 'workspace_cleanup_failed',
          });
        }
        await rm(workspacePath, { recursive: true, force: true });
        return writeWorkspaceRecord({
          dir: recordRoot,
          record: { ...current, state: 'released', hold_reason: null, last_error: null },
          now,
        });
      } catch (error) {
        await writeWorkspaceRecord({
          dir: recordRoot,
          record: { ...current, state: 'failed', last_error: 'workspace_cleanup_failed' },
          now,
        });
        throw error;
      }
    },
  });
}
