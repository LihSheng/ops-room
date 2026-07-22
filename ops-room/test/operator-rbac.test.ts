import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasOperatorPermission,
  normalizeOperatorRoles,
  permissionsForOperatorRoles,
  requireOperatorPermission,
} from '../src/services/operator-rbac.js';

test('operator roles are normalized, deduplicated, and preserve configured order', () => {
  assert.deepEqual(normalizeOperatorRoles('operator, reviewer,operator'), ['operator', 'reviewer']);
  assert.deepEqual(normalizeOperatorRoles(['viewer', 'deployer']), ['viewer', 'deployer']);
});

test('missing and unknown roles fail closed', () => {
  assert.throws(() => normalizeOperatorRoles(''), /operator_roles_missing/);
  assert.throws(() => normalizeOperatorRoles('owner'), /operator_role_unknown:owner/);
  assert.equal(hasOperatorPermission(['owner'], 'dashboard.read'), false);
});

test('permissions are the union of configured roles', () => {
  const permissions = permissionsForOperatorRoles(['operator', 'reviewer']);
  assert.equal(permissions.includes('dashboard.read'), true);
  assert.equal(permissions.includes('task.manage'), true);
  assert.equal(permissions.includes('workflow.recover'), true);
  assert.equal(permissions.includes('workflow.approve'), true);
  assert.equal(permissions.includes('policy.manage'), false);
  assert.equal(permissions.includes('release.approve'), false);
});

test('administrator and deployer remain separate authorities', () => {
  assert.equal(hasOperatorPermission(['administrator'], 'repository.manage'), true);
  assert.equal(hasOperatorPermission(['administrator'], 'release.approve'), false);
  assert.equal(hasOperatorPermission(['deployer'], 'release.approve'), true);
  assert.equal(hasOperatorPermission(['deployer'], 'task.manage'), false);
});

test('unknown permissions and denied actions fail closed', () => {
  assert.equal(hasOperatorPermission(['administrator'], 'shell.execute'), false);
  assert.throws(
    () => requireOperatorPermission(['viewer'], 'task.manage'),
    /operator_permission_denied:task.manage/,
  );
  assert.doesNotThrow(() => requireOperatorPermission(['operator'], 'task.manage'));
});
