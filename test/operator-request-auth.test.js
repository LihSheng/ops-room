import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeOperatorRequest, deriveOperatorCsrfToken, OPERATOR_CSRF_HEADER_NAME, } from '../src/services/operator-request-auth.js';
import { listAuditEvents } from '../src/services/audit-log.js';
import { createOperatorSession } from '../src/services/operator-session-store.js';
const ACTOR = Object.freeze({
    actor_type: 'human_operator',
    actor_id: 'operator-1',
    actor_display_name: 'Operator One',
    auth_method: 'operator_token',
});
async function sessionFixture(roles) {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-request-auth-'));
    const sessionDir = join(root, 'sessions');
    const auditDir = join(root, 'audit');
    const token = roles.includes('viewer') ? 'v'.repeat(43) : 'o'.repeat(43);
    const created = await createOperatorSession({
        dir: sessionDir,
        actor: ACTOR,
        roles,
        ttlSeconds: 3600,
        generateToken: () => token,
        now: () => '2026-07-22T00:00:00.000Z',
    });
    return { root, sessionDir, auditDir, token, session: created.session };
}
test('legacy operator bearer remains authorized without session CSRF', async () => {
    const result = await authorizeOperatorRequest({
        req: { method: 'POST', headers: { authorization: 'Bearer legacy' } },
        permission: 'task.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: false,
        verifyOperatorBearer: (authorization) => authorization === 'Bearer legacy',
        resolveBearerActor: () => ACTOR,
    });
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.equal(result.auth_method, 'operator_token');
    assert.equal(result.actor.actor_id, ACTOR.actor_id);
});
test('cookie session requires permission and a valid CSRF token for mutation', async () => {
    const fixture = await sessionFixture(['operator']);
    const result = await authorizeOperatorRequest({
        req: {
            method: 'POST',
            url: '/api/operator/tasks/task-1/retry',
            headers: {
                cookie: `ops_room_session=${fixture.token}`,
                [OPERATOR_CSRF_HEADER_NAME]: deriveOperatorCsrfToken(fixture.token),
            },
        },
        permission: 'task.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        sessionDir: fixture.sessionDir,
        auditDir: fixture.auditDir,
        verifyOperatorBearer: () => false,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.equal(result.auth_method, 'operator_session');
    assert.equal(result.actor.auth_method, 'operator_session');
    assert.equal(result.actor.session_id, fixture.session.session_id);
});
test('cookie mutation fails closed and records session-attributed CSRF denial', async () => {
    const fixture = await sessionFixture(['operator']);
    const result = await authorizeOperatorRequest({
        req: {
            method: 'POST',
            url: '/api/operator/tasks/task-1/retry',
            headers: { cookie: `ops_room_session=${fixture.token}` },
        },
        permission: 'task.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        sessionDir: fixture.sessionDir,
        auditDir: fixture.auditDir,
        verifyOperatorBearer: () => false,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.deepEqual(result, {
        ok: false,
        status: 403,
        error: 'Forbidden',
        error_code: 'operator_csrf_invalid',
    });
    const events = await listAuditEvents({
        dir: fixture.auditDir,
        operation: 'operator.authorization.denied',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor.actor_id, ACTOR.actor_id);
    assert.equal(events[0].actor.session_id, fixture.session.session_id);
    assert.equal(events[0].target.id, 'task.manage');
    assert.equal(events[0].error_code, 'operator_csrf_invalid');
    assert.deepEqual(events[0].metadata, {
        method: 'POST',
        path: '/api/operator/tasks/task-1/retry',
    });
});
test('session role without the required permission is forbidden and audited', async () => {
    const fixture = await sessionFixture(['viewer']);
    const result = await authorizeOperatorRequest({
        req: {
            method: 'GET',
            url: '/api/audit-events',
            headers: { cookie: `ops_room_session=${fixture.token}` },
        },
        permission: 'policy.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        sessionDir: fixture.sessionDir,
        auditDir: fixture.auditDir,
        verifyOperatorBearer: () => false,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.equal(result.ok, false);
    if (result.ok)
        return;
    assert.equal(result.status, 403);
    assert.equal(result.error_code, 'operator_permission_denied');
    const events = await listAuditEvents({
        dir: fixture.auditDir,
        operation: 'operator.authorization.denied',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor.session_id, fixture.session.session_id);
    assert.equal(events[0].target.id, 'policy.manage');
    assert.equal(events[0].error_code, 'operator_permission_denied');
});
test('authorization denial returns bounded unavailable when audit cannot persist', async () => {
    const fixture = await sessionFixture(['viewer']);
    const result = await authorizeOperatorRequest({
        req: {
            method: 'GET',
            url: '/api/audit-events',
            headers: { cookie: `ops_room_session=${fixture.token}` },
        },
        permission: 'policy.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        sessionDir: fixture.sessionDir,
        verifyOperatorBearer: () => false,
        appendAudit: async () => { throw new Error('audit unavailable'); },
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.deepEqual(result, {
        ok: false,
        status: 503,
        error: 'Operator audit unavailable',
        error_code: 'operator_audit_unavailable',
    });
});
test('operator API disabled remains hidden for bearer and session requests', async () => {
    const result = await authorizeOperatorRequest({
        req: { method: 'POST', headers: { authorization: 'Bearer legacy' } },
        permission: 'task.manage',
        operatorApiEnabled: false,
        humanAuthEnabled: true,
        verifyOperatorBearer: () => true,
    });
    assert.deepEqual(result, {
        ok: false,
        status: 404,
        error: 'Not found',
        error_code: 'operator_api_disabled',
    });
});
//# sourceMappingURL=operator-request-auth.test.js.map