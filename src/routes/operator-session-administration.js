import { appendAuditEvent } from '../services/audit-log.js';
import { executeIdempotent, IdempotencyConflictError, IdempotencyInProgressError, validateIdempotencyKey, } from '../services/idempotency-store.js';
import { clearOperatorSessionCookie, listOperatorSessions, readOperatorSessionById, revokeOperatorSessionById, validateOperatorSessionId, } from '../services/operator-session-store.js';
import { AUDIT_DIR, IDEMPOTENCY_DIR, OPERATOR_SESSION_COOKIE_SECURE, OPERATOR_SESSION_DIR, } from '../services/runtime-paths.js';
const sessionAdministrationLocks = new Map();
async function withSessionAdministrationLock(sessionId, execute) {
    const previous = sessionAdministrationLocks.get(sessionId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    sessionAdministrationLocks.set(sessionId, queued);
    await previous;
    try {
        return await execute();
    }
    finally {
        release();
        if (sessionAdministrationLocks.get(sessionId) === queued) {
            sessionAdministrationLocks.delete(sessionId);
        }
    }
}
function queryValue(searchParams, name) {
    return String(searchParams?.get(name) || '').trim();
}
function reasonFrom(body) {
    const reason = String(body?.reason || '').trim();
    if (!reason || reason.length > 500) {
        throw new Error('reason is required and must not exceed 500 characters');
    }
    return reason;
}
async function rejected({ auditDir, actor, sessionId, reason, idempotencyKey, errorCode, status, message, previousState = null, }) {
    const event = await appendAuditEvent({
        dir: auditDir,
        operation: 'operator.session.revoke.admin',
        actor,
        target: { type: 'operator_session', id: String(sessionId || '').slice(0, 300) },
        reason,
        idempotencyKey,
        previousState,
        resultingState: previousState,
        outcome: 'rejected',
        errorCode,
    });
    return {
        status,
        body: {
            error: message,
            error_code: errorCode,
            audit_event_id: event.event_id,
        },
    };
}
export async function handleOperatorSessionsList({ searchParams, sessionDir = OPERATOR_SESSION_DIR, now, }) {
    try {
        const sessions = await listOperatorSessions({
            dir: sessionDir,
            limit: queryValue(searchParams, 'limit') || 100,
            actorId: queryValue(searchParams, 'actor_id'),
            status: queryValue(searchParams, 'status'),
            now,
        });
        return { status: 200, body: { sessions, count: sessions.length } };
    }
    catch (error) {
        if (String(error?.message || '').endsWith('_invalid')) {
            return {
                status: 400,
                body: { error: 'Invalid session-list filter', error_code: error.message },
            };
        }
        throw error;
    }
}
export async function handleOperatorSessionAdministrativeRevoke({ sessionId, body, actor, sessionDir = OPERATOR_SESSION_DIR, auditDir = AUDIT_DIR, idempotencyDir = IDEMPOTENCY_DIR, secureCookie = OPERATOR_SESSION_COOKIE_SECURE, now, }) {
    let normalizedSessionId = String(sessionId || '').trim().slice(0, 300);
    let reason = String(body?.reason || '').trim().slice(0, 500);
    let idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).trim() : null;
    try {
        normalizedSessionId = validateOperatorSessionId(sessionId);
        reason = reasonFrom(body);
        idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
    }
    catch (error) {
        return rejected({
            auditDir,
            actor,
            sessionId: normalizedSessionId,
            reason,
            idempotencyKey,
            errorCode: 'invalid_request',
            status: 400,
            message: error.message,
        });
    }
    try {
        const result = await executeIdempotent({
            dir: idempotencyDir,
            actorId: actor.actor_id,
            operation: 'operator.session.revoke.admin',
            targetId: normalizedSessionId,
            key: idempotencyKey,
            payload: { reason },
            execute: () => withSessionAdministrationLock(normalizedSessionId, async () => {
                const current = await readOperatorSessionById({ dir: sessionDir, sessionId: normalizedSessionId, now });
                if (!current) {
                    return rejected({
                        auditDir,
                        actor,
                        sessionId: normalizedSessionId,
                        reason,
                        idempotencyKey,
                        errorCode: 'operator_session_not_found',
                        status: 404,
                        message: 'Operator session not found',
                    });
                }
                const revoked = await revokeOperatorSessionById({
                    dir: sessionDir,
                    sessionId: normalizedSessionId,
                    actor,
                    reason,
                    idempotencyKey,
                    now,
                });
                if (!revoked) {
                    return rejected({
                        auditDir,
                        actor,
                        sessionId: normalizedSessionId,
                        reason,
                        idempotencyKey,
                        errorCode: 'operator_session_not_found',
                        status: 404,
                        message: 'Operator session not found',
                        previousState: current.status,
                    });
                }
                const event = await appendAuditEvent({
                    dir: auditDir,
                    operation: 'operator.session.revoke.admin',
                    actor,
                    target: { type: 'operator_session', id: normalizedSessionId },
                    reason,
                    idempotencyKey,
                    previousState: current.status,
                    resultingState: 'revoked',
                    outcome: 'accepted',
                    metadata: {
                        target_actor_id: revoked.session.actor.actor_id,
                        target_roles: revoked.session.roles,
                        already_revoked: revoked.already_revoked,
                    },
                });
                return {
                    status: 200,
                    body: {
                        operation: 'operator.session.revoke.admin',
                        session: revoked.session,
                        already_revoked: revoked.already_revoked,
                        audit_event_id: event.event_id,
                    },
                    headers: actor.session_id === normalizedSessionId
                        ? { 'Set-Cookie': clearOperatorSessionCookie({ secure: secureCookie }) }
                        : undefined,
                };
            }),
        });
        return {
            status: result.response.status,
            body: { ...result.response.body, idempotent_replay: result.replayed },
            headers: result.response.headers,
        };
    }
    catch (error) {
        if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
            const current = await readOperatorSessionById({ dir: sessionDir, sessionId: normalizedSessionId, now });
            return rejected({
                auditDir,
                actor,
                sessionId: normalizedSessionId,
                reason,
                idempotencyKey,
                errorCode: error.code,
                status: 409,
                message: error.message,
                previousState: current?.status || null,
            });
        }
        throw error;
    }
}
//# sourceMappingURL=operator-session-administration.js.map