import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  handleOperatorSessionAdministrativeRevoke,
  handleOperatorSessionsList,
} from '../src/routes/operator-session-administration.js';
import { listAuditEvents } from '../src/services/audit-log.js';
import { hasOperatorPermission } from '../src/services/operator-rbac.js';
import {
  createOperatorSession,
  listOperatorSessions,
  readOperatorSessionById,
} from '../src/services/operator-session-store.js';

const ADMIN = Object.freeze({
  actor_type: 'human_operator',
  actor_id: 'admin-1',
  actor_display_name: 'Administrator One',
  auth_method: 'operator_session',
  session_id: 'session:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
});
const TARGET_ACTOR = Object.freeze({
  actor_type: 'human_operator',
  actor_id: 'operator-1',
  actor_display_name: 'Operator One',
  auth_method: 'operator_token',
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-session-admin-'));
  const sessionDir = join(root, 'sessions');
  const auditDir = join(root, 'audit');
  const idempotencyDir = join(root, 'idempotency');
  const target = await createOperatorSession({
    dir: sessionDir,
    actor: TARGET_ACTOR,
    roles: ['operator'],
    ttlSeconds: 3600,
    generateToken: () => 't'.repeat(43),
    now: () => '2026-07-22T00:00:00.000Z',
  });
  return { root, sessionDir, auditDir, idempotencyDir, target };
}

test('session.manage is administrator-only', () => {
  assert.equal(hasOperatorPermission(['administrator'], 'session.manage'), true);
  assert.equal(hasOperatorPermission(['operator'], 'session.manage'), false);
  assert.equal(hasOperatorPermission(['reviewer'], 'session.manage'), false);
  assert.equal(hasOperatorPermission(['deployer'], 'session.manage'), false);
});

test('administrative listing exposes bounded metadata without authentication material', async () => {
  const f = await fixture();
  const result = await handleOperatorSessionsList({
    searchParams: new URLSearchParams('status=active&limit=10'),
    sessionDir: f.sessionDir,
    now: () => '2026-07-22T00:10:00.000Z',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  const [session] = result.body.sessions;
  assert.equal(session.session_id, f.target.session.session_id);
  assert.equal(session.status, 'active');
  assert.equal(session.actor.actor_id, TARGET_ACTOR.actor_id);
  assert.equal('token' in session, false);
  assert.equal('token_hash' in session, false);
  assert.equal(JSON.stringify(session).includes('t'.repeat(43)), false);
});

test('administrative listing rejects malformed limits', async () => {
  const f = await fixture();
  const result = await handleOperatorSessionsList({
    searchParams: new URLSearchParams('limit=not-a-number'),
    sessionDir: f.sessionDir,
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error_code, 'operator_session_limit_filter_invalid');
});

test('cross-session revocation requires reason and idempotency and records durable evidence', async () => {
  const f = await fixture();
  const input = {
    sessionId: f.target.session.session_id,
    body: { reason: 'Compromised browser', idempotency_key: 'revoke-session-0001' },
    actor: ADMIN,
    sessionDir: f.sessionDir,
    auditDir: f.auditDir,
    idempotencyDir: f.idempotencyDir,
    secureCookie: false,
    now: () => '2026-07-22T00:20:00.000Z',
  };

  const revoked = await handleOperatorSessionAdministrativeRevoke(input);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.idempotent_replay, false);
  assert.equal(revoked.body.session.status, 'revoked');
  assert.equal(revoked.body.session.revocation.actor_id, ADMIN.actor_id);
  assert.equal(revoked.body.session.revocation.reason, 'Compromised browser');

  const persisted = await readOperatorSessionById({
    dir: f.sessionDir,
    sessionId: f.target.session.session_id,
    now: () => '2026-07-22T00:21:00.000Z',
  });
  assert.equal(persisted?.status, 'revoked');
  assert.equal(persisted?.revocation.idempotency_key, 'revoke-session-0001');

  const replay = await handleOperatorSessionAdministrativeRevoke(input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent_replay, true);

  const events = await listAuditEvents({
    dir: f.auditDir,
    operation: 'operator.session.revoke.admin',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor.actor_id, ADMIN.actor_id);
  assert.equal(events[0].target.id, f.target.session.session_id);
  assert.equal(events[0].reason, 'Compromised browser');
  assert.equal(events[0].idempotency_key, 'revoke-session-0001');
  assert.equal(events[0].resulting_state, 'revoked');
});

test('invalid administrative revocation is rejected and audited', async () => {
  const f = await fixture();
  const result = await handleOperatorSessionAdministrativeRevoke({
    sessionId: f.target.session.session_id,
    body: { reason: '', idempotency_key: 'revoke-session-0002' },
    actor: ADMIN,
    sessionDir: f.sessionDir,
    auditDir: f.auditDir,
    idempotencyDir: f.idempotencyDir,
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error_code, 'invalid_request');
  const events = await listAuditEvents({ dir: f.auditDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'rejected');
});

test('revoking the current administrator session clears its browser cookie', async () => {
  const f = await fixture();
  const selfActor = Object.freeze({ ...ADMIN, session_id: f.target.session.session_id });
  const result = await handleOperatorSessionAdministrativeRevoke({
    sessionId: f.target.session.session_id,
    body: { reason: 'Sign out all access', idempotency_key: 'revoke-session-0003' },
    actor: selfActor,
    sessionDir: f.sessionDir,
    auditDir: f.auditDir,
    idempotencyDir: f.idempotencyDir,
    secureCookie: false,
    now: () => '2026-07-22T00:30:00.000Z',
  });

  assert.equal(result.status, 200);
  assert.ok(result.headers?.['Set-Cookie'].includes('Max-Age=0'));
  const sessions = await listOperatorSessions({
    dir: f.sessionDir,
    status: 'revoked',
    now: () => '2026-07-22T00:31:00.000Z',
  });
  assert.equal(sessions.length, 1);
});
