import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  repositoryCacheKey,
  repositoryCachePath,
  validateRepositoryId,
} from '../src/services/repository-cache.js';
import { validateWorkspaceRecord, WORKSPACE_RECORD_VERSION } from '../src/services/workspace-store.js';

test('canonical owner/name repository identity is preserved while cache key is filesystem-safe', () => {
  const repository = 'LihSheng/LinkUp';
  assert.equal(validateRepositoryId(repository), repository);
  const key = repositoryCacheKey(repository);
  assert.match(key, /^LihSheng--LinkUp-[a-f0-9]{16}$/);
  assert.equal(key.includes('/'), false);
  const path = repositoryCachePath(join(tmpdir(), 'repositories'), repository);
  assert.equal(path.endsWith(`${key}.git`), true);
});

test('workspace records accept canonical repository identity and reject traversal-shaped identities', () => {
  const record = validateWorkspaceRecord({
    version: WORKSPACE_RECORD_VERSION,
    workspace_id: 'workspace-1',
    owner_agent: 'berlin',
    task_id: 'task-1',
    repository_id: 'LihSheng/ops-room',
    mode: 'detached',
    branch: null,
    requested_sha: 'a'.repeat(40),
    resolved_sha: 'a'.repeat(40),
    relative_path: 'berlin/workspace-1',
    state: 'active',
  });
  assert.equal(record.repository_id, 'LihSheng/ops-room');
  for (const invalid of ['../repo', 'owner/repo/extra', 'owner\\repo', '/repo', 'owner/..']) {
    assert.throws(() => validateRepositoryId(invalid), /invalid_repository_id/);
  }
});
