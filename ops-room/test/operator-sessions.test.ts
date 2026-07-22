import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  handleCreateOperatorSession,
  handleReadOperatorSession,
  handleRevokeOperatorSession,
} from '../src/routes/operator-sessions.js';
import { extractOperatorSessionToken } from '../src/services/operator-session-store.js';

const ACTOR = Object.freeze({
  actor_type: 'human_operator',
  actor_id: 'operator-1',
  actor_display_name: 'Operator One',
  auth_method: 'operator_token',
});

test('bootstrap creates a secure bounded session that can be read and revoked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-session-routes-'));
  const created = await handleCreateOperatorSession({
    authorization: 'Bearer bootstrap',
    enabled: true,
    sessionDir: dir,
    roles: ['operator'],
    ttlSeconds: 3600,
    secureCookie: false,
    verifyBootstrapAuth: (authorization) => authorization === 'Bearer bootstrap',
    resolveActor: () => ACTOR,
    now: () => '2026-07-22T00:00:00.000Z',
  });

  assert.equal(created.status, 201);
  assert.ok(created.headers?.['Set-Cookie'].includes('HttpOnly'));
  assert.ok(created.headers?.['Set-Cookie'].includes('SameSite=Strict'));
  assert.equal(created.headers?.['Set-Cookie'].includes('Secure'), false);
  assert.match(String(created.body.csrf_token), /^[A-Za-z0-9_-]{43}$/);

  const token = extractOperatorSessionToken(created.headers?.['Set-Cookie']);
  assert.ok(token);

  const read = await handleReadOperatorSession({
    cookieHeader: `ops_room_session=${token}`,
    enabled: true,
    sessionDir: dir,
    now: () => '2026-07-22T00:10:00.000Z',
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.session.actor.actor_id, ACTOR.actor_id);
  assert.equal(read.body.csrf_token, created.body.csrf_token);

  const rejectedRevoke = await handleRevokeOperatorSession({
    cookieHeader: `ops_room_session=${token}`,
    csrfHeader: 'invalid',
    enabled: true,
    sessionDir: dir,
    secureCookie: false,
    now: () => '2026-07-22T00:20:00.000Z',
  });
  assert.equal(rejectedRevoke.status, 403);
  assert.equal(rejectedRevoke.body.error_code, 'operator_csrf_invalid');

  const revoked = await handleRevokeOperatorSession({
    cookieHeader: `ops_room_session=${token}`,
    csrfHeader: created.body.csrf_token,
    enabled: true,
    sessionDir: dir,
    secureCookie: false,
    now: () => '2026-07-22T00:20:00.000Z',
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.ok, true);
  assert.ok(revoked.headers?.['Set-Cookie'].includes('Max-Age=0'));

  const afterRevocation = await handleReadOperatorSession({
    cookieHeader: `ops_room_session=${token}`,
    enabled: true,
    sessionDir: dir,
    now: () => '2026-07-22T00:21:00.000Z',
  });
  assert.equal(afterRevocation.status, 401);
});

test('session endpoints remain hidden when human authentication is disabled', async () => {
  const created = await handleCreateOperatorSession({
    authorization: 'Bearer bootstrap',
    enabled: false,
  });
  const read = await handleReadOperatorSession({
    cookieHeader: '',
    enabled: false,
  });
  const revoked = await handleRevokeOperatorSession({
    cookieHeader: '',
    csrfHeader: '',
    enabled: false,
  });

  assert.equal(created.status, 404);
  assert.equal(read.status, 404);
  assert.equal(revoked.status, 404);
});

test('bootstrap rejects a request without the dedicated operator bearer', async () => {
  const result = await handleCreateOperatorSession({
    authorization: 'Bearer dashboard-token',
    enabled: true,
    verifyBootstrapAuth: () => false,
  });

  assert.deepEqual(result, {
    status: 401,
    body: { error: 'Unauthorized' },
    headers: undefined,
  });
});
