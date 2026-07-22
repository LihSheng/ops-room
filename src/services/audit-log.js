import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const SAFE_EVENT_ID = /^[A-Fa-f0-9-]{16,64}$/;
function eventPath(dir, eventId) {
    if (!SAFE_EVENT_ID.test(String(eventId)))
        throw new Error('Invalid audit event ID');
    return join(dir, `event-${eventId}.json`);
}
function boundedText(value, maxLength = 500) {
    return String(value ?? '').trim().slice(0, maxLength);
}
export async function appendAuditEvent({ dir, operation, actor, target, reason, idempotencyKey = null, previousState = null, resultingState = null, outcome, errorCode = null, metadata = null, eventId = randomUUID(), createdAt = new Date().toISOString(), }) {
    await mkdir(dir, { recursive: true });
    const event = {
        schema: 'ops-room.audit-event.v1',
        event_id: eventId,
        operation: boundedText(operation, 120),
        actor: {
            actor_type: boundedText(actor?.actor_type, 60),
            actor_id: boundedText(actor?.actor_id, 100),
            actor_display_name: boundedText(actor?.actor_display_name, 120),
            auth_method: boundedText(actor?.auth_method, 60),
            ...(actor?.session_id ? { session_id: boundedText(actor.session_id, 100) } : {}),
        },
        target: {
            type: boundedText(target?.type, 80),
            id: boundedText(target?.id, 300),
        },
        reason: boundedText(reason, 500),
        idempotency_key: idempotencyKey ? boundedText(idempotencyKey, 128) : null,
        previous_state: previousState ? boundedText(previousState, 80) : null,
        resulting_state: resultingState ? boundedText(resultingState, 80) : null,
        outcome: boundedText(outcome, 40),
        error_code: errorCode ? boundedText(errorCode, 100) : null,
        metadata: metadata && typeof metadata === 'object' ? metadata : null,
        created_at: createdAt,
    };
    const handle = await open(eventPath(dir, eventId), 'wx', 0o640);
    try {
        await handle.writeFile(`${JSON.stringify(event, null, 2)}\n`, 'utf-8');
    }
    finally {
        await handle.close();
    }
    return event;
}
export async function readAuditEvent({ dir, eventId }) {
    try {
        return JSON.parse(await readFile(eventPath(dir, eventId), 'utf-8'));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
}
export async function listAuditEvents({ dir, limit = 50, actorId, sessionId, operation, targetId, outcome, from, to, } = {}) {
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return [];
        throw error;
    }
    const events = [];
    for (const name of names.filter((entry) => /^event-[A-Fa-f0-9-]+\.json$/.test(entry))) {
        try {
            const event = JSON.parse(await readFile(join(dir, name), 'utf-8'));
            if (actorId && event.actor?.actor_id !== actorId)
                continue;
            if (sessionId && event.actor?.session_id !== sessionId)
                continue;
            if (operation && event.operation !== operation)
                continue;
            if (targetId && event.target?.id !== targetId)
                continue;
            if (outcome && event.outcome !== outcome)
                continue;
            if (from && String(event.created_at) < String(from))
                continue;
            if (to && String(event.created_at) > String(to))
                continue;
            events.push(event);
        }
        catch (error) {
            if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError))
                throw error;
        }
    }
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    return events
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, boundedLimit);
}
//# sourceMappingURL=audit-log.js.map