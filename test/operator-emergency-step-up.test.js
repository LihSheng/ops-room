import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listAuditEvents } from '../src/services/audit-log.js';
import { authorizeOperatorRequest, deriveOperatorCsrfToken, OPERATOR_CONFIRMATION_HEADER_NAME, OPERATOR_CSRF_HEADER_NAME, operatorStepUpConfirmationValue, requiresOperatorStepUp, } from '../src/services/operator-request-auth.js';
import { createOperatorSession } from '../src/services/operator-session-store.js';
const BEARER_ACTOR = Object.freeze({
    actor_type: 'human_operator',
    actor_id: 'operator-1',
    actor_display_name: 'Operator One',
    auth_method: 'operator_token',
});
async function administratorSessionFixture() {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-step-up-'));
    const sessionDir = join(root, 'sessions');
    const auditDir = join(root, 'audit');
    const token = 's'.repeat(43);
    const created = await createOperatorSession({
        dir: sessionDir,
        actor: BEARER_ACTOR,
        roles: ['administrator'],
        ttlSeconds: 3600,
        generateToken: () => token,
        now: () => '2026-07-22T00:00:00.000Z',
    });
    return { root, sessionDir, auditDir, token, session: created.session };
}
test('emergency read-only blocks bearer mutations and records the actor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-emergency-'));
    const auditDir = join(root, 'audit');
    const result = await authorizeOperatorRequest({
        req: {
            method: 'POST',
            url: '/api/operator/tasks/task-1/retry',
            headers: { authorization: 'Bearer legacy' },
        },
        permission: 'task.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: false,
        emergencyReadOnlyEnabled: true,
        auditDir,
        verifyOperatorBearer: (value) => value === 'Bearer legacy',
        resolveBearerActor: () => BEARER_ACTOR,
    });
    assert.deepEqual(result, {
        ok: false,
        status: 423,
        error: 'Operator mutations are disabled',
        error_code: 'operator_emergency_read_only',
    });
    const events = await listAuditEvents({ dir: auditDir, operation: 'operator.authorization.denied' });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor.actor_id, BEARER_ACTOR.actor_id);
    assert.equal(events[0].error_code, 'operator_emergency_read_only');
    assert.deepEqual(events[0].metadata, {
        method: 'POST',
        path: '/api/operator/tasks/task-1/retry',
    });
});
test('emergency read-only preserves authenticated reads', async () => {
    const result = await authorizeOperatorRequest({
        req: {
            method: 'GET',
            url: '/api/audit-events',
            headers: { authorization: 'Bearer legacy' },
        },
        permission: 'policy.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: false,
        emergencyReadOnlyEnabled: true,
        verifyOperatorBearer: (value) => value === 'Bearer legacy',
        resolveBearerActor: () => BEARER_ACTOR,
    });
    assert.equal(result.ok, true);
});
test('sensitive browser-session mutation requires exact action-bound confirmation', async () => {
    const fixture = await administratorSessionFixture();
    const path = '/api/operator/agents/professor/stop';
    const baseHeaders = {
        cookie: `ops_room_session=${fixture.token}`,
        [OPERATOR_CSRF_HEADER_NAME]: deriveOperatorCsrfToken(fixture.token),
    };
    const missing = await authorizeOperatorRequest({
        req: { method: 'POST', url: path, headers: baseHeaders },
        permission: 'agent.lifecycle',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        emergencyReadOnlyEnabled: false,
        sessionDir: fixture.sessionDir,
        auditDir: fixture.auditDir,
        verifyOperatorBearer: () => false,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.deepEqual(missing, {
        ok: false,
        status: 428,
        error: 'Action confirmation required',
        error_code: 'operator_step_up_required',
    });
    const wrongPathConfirmation = operatorStepUpConfirmationValue({
        permission: 'agent.lifecycle',
        method: 'POST',
        path: '/api/operator/agents/tokyo/stop',
    });
    const mismatched = await authorizeOperatorRequest({
        req: {
            method: 'POST',
            url: path,
            headers: {
                ...baseHeaders,
                [OPERATOR_CONFIRMATION_HEADER_NAME]: wrongPathConfirmation,
            },
        },
        permission: 'agent.lifecycle',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        emergencyReadOnlyEnabled: false,
        sessionDir: fixture.sessionDir,
        auditDir: fixture.auditDir,
        verifyOperatorBearer: () => false,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.equal(mismatched.ok, false);
    if (mismatched.ok)
        return;
    assert.equal(mismatched.error_code, 'operator_step_up_required');
    const confirmation = operatorStepUpConfirmationValue({
        permission: 'agent.lifecycle',
        method: 'POST',
        path,
    });
    const accepted = await authorizeOperatorRequest({
        req: {
            method: 'POST',
            url: path,
            headers: {
                ...baseHeaders,
                [OPERATOR_CONFIRMATION_HEADER_NAME]: confirmation,
            },
        },
        permission: 'agent.lifecycle',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        emergencyReadOnlyEnabled: false,
        sessionDir: fixture.sessionDir,
        auditDir: fixture.auditDir,
        verifyOperatorBearer: () => false,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.equal(accepted.ok, true);
    const events = await listAuditEvents({ dir: fixture.auditDir, operation: 'operator.authorization.denied' });
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.actor.session_id === fixture.session.session_id));
    assert.ok(events.every((event) => event.error_code === 'operator_step_up_required'));
});
test('ordinary task management does not require step-up confirmation', async () => {
    const fixture = await administratorSessionFixture();
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
        emergencyReadOnlyEnabled: false,
        sessionDir: fixture.sessionDir,
        auditDir: fixture.auditDir,
        verifyOperatorBearer: () => false,
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(requiresOperatorStepUp('task.manage'), false);
    assert.equal(requiresOperatorStepUp('session.manage'), true);
});
test('step-up and emergency denials fail closed when audit persistence is unavailable', async () => {
    const fixture = await administratorSessionFixture();
    const stepUp = await authorizeOperatorRequest({
        req: {
            method: 'POST',
            url: '/api/operator/sessions/session:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/revoke',
            headers: {
                cookie: `ops_room_session=${fixture.token}`,
                [OPERATOR_CSRF_HEADER_NAME]: deriveOperatorCsrfToken(fixture.token),
            },
        },
        permission: 'session.manage',
        operatorApiEnabled: true,
        humanAuthEnabled: true,
        emergencyReadOnlyEnabled: false,
        sessionDir: fixture.sessionDir,
        verifyOperatorBearer: () => false,
        appendAudit: async () => { throw new Error('audit unavailable'); },
        now: () => '2026-07-22T00:10:00.000Z',
    });
    assert.deepEqual(stepUp, {
        ok: false,
        status: 503,
        error: 'Operator audit unavailable',
        error_code: 'operator_audit_unavailable',
    });
});
//# sourceMappingURL=operator-emergency-step-up.test.js.map