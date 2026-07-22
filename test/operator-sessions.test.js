import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleCreateOperatorSession, handleReadOperatorSession, handleRevokeOperatorSession, } from '../src/routes/operator-sessions.js';
import { listAuditEvents } from '../src/services/audit-log.js';
import { extractOperatorSessionToken } from '../src/services/operator-session-store.js';
const ACTOR = Object.freeze({
    actor_type: 'human_operator',
    actor_id: 'operator-1',
    actor_display_name: 'Operator One',
    auth_method: 'operator_token',
});
test('bootstrap creates, audits, reads, and revokes a bounded session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-session-routes-'));
    const sessionDir = join(root, 'sessions');
    const auditDir = join(root, 'audit');
    const created = await handleCreateOperatorSession({
        authorization: 'Bearer bootstrap',
        enabled: true,
        sessionDir,
        auditDir,
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
    const creationEvents = await listAuditEvents({ auditDir, dir: auditDir });
    assert.equal(creationEvents.length, 1);
    assert.equal(creationEvents[0].operation, 'operator.session.create');
    assert.equal(creationEvents[0].actor.actor_id, ACTOR.actor_id);
    assert.equal(creationEvents[0].actor.auth_method, 'operator_token');
    assert.equal(creationEvents[0].target.id, created.body.session.session_id);
    assert.equal(creationEvents[0].resulting_state, 'active');
    const token = extractOperatorSessionToken(created.headers?.['Set-Cookie']);
    assert.ok(token);
    const read = await handleReadOperatorSession({
        cookieHeader: `ops_room_session=${token}`,
        enabled: true,
        sessionDir,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.session.actor.actor_id, ACTOR.actor_id);
    assert.equal(read.body.csrf_token, created.body.csrf_token);
    const rejectedRevoke = await handleRevokeOperatorSession({
        cookieHeader: `ops_room_session=${token}`,
        csrfHeader: 'invalid',
        enabled: true,
        sessionDir,
        auditDir,
        secureCookie: false,
        now: () => '2026-07-22T00:20:00.000Z',
    });
    assert.equal(rejectedRevoke.status, 403);
    assert.equal(rejectedRevoke.body.error_code, 'operator_csrf_invalid');
    const deniedEvents = await listAuditEvents({
        dir: auditDir,
        operation: 'operator.authorization.denied',
    });
    assert.equal(deniedEvents.length, 1);
    assert.equal(deniedEvents[0].actor.session_id, created.body.session.session_id);
    assert.equal(deniedEvents[0].error_code, 'operator_csrf_invalid');
    const revoked = await handleRevokeOperatorSession({
        cookieHeader: `ops_room_session=${token}`,
        csrfHeader: created.body.csrf_token,
        enabled: true,
        sessionDir,
        auditDir,
        secureCookie: false,
        now: () => '2026-07-22T00:20:00.000Z',
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.ok, true);
    assert.ok(revoked.headers?.['Set-Cookie'].includes('Max-Age=0'));
    const revokeEvents = await listAuditEvents({
        dir: auditDir,
        operation: 'operator.session.revoke',
    });
    assert.equal(revokeEvents.length, 1);
    assert.equal(revokeEvents[0].actor.session_id, created.body.session.session_id);
    assert.equal(revokeEvents[0].previous_state, 'active');
    assert.equal(revokeEvents[0].resulting_state, 'revoked');
    const afterRevocation = await handleReadOperatorSession({
        cookieHeader: `ops_room_session=${token}`,
        enabled: true,
        sessionDir,
        now: () => '2026-07-22T00:21:00.000Z',
    });
    assert.equal(afterRevocation.status, 401);
});
test('session creation rolls back when durable audit evidence cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-session-audit-failure-'));
    let revokedToken = null;
    const result = await handleCreateOperatorSession({
        authorization: 'Bearer bootstrap',
        enabled: true,
        sessionDir: join(root, 'sessions'),
        auditDir: join(root, 'audit'),
        roles: ['operator'],
        ttlSeconds: 3600,
        verifyBootstrapAuth: () => true,
        resolveActor: () => ACTOR,
        appendAudit: async () => { throw new Error('audit unavailable'); },
        revokeSession: async ({ token }) => {
            revokedToken = token;
            return null;
        },
        now: () => '2026-07-22T00:00:00.000Z',
    });
    assert.equal(result.status, 503);
    assert.match(String(revokedToken), /^[A-Za-z0-9_-]{43}$/);
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
//# sourceMappingURL=operator-sessions.test.js.map