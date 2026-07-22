import { listAuditEvents, readAuditEvent } from '../services/audit-log.js';
export async function handleAuditEventsList(searchParams, { auditDir }) {
    const events = await listAuditEvents({
        dir: auditDir,
        limit: searchParams.get('limit'),
        actorId: searchParams.get('actor') || undefined,
        operation: searchParams.get('operation') || undefined,
        targetId: searchParams.get('target_id') || undefined,
        outcome: searchParams.get('outcome') || undefined,
        from: searchParams.get('from') || undefined,
        to: searchParams.get('to') || undefined,
    });
    return { events };
}
export async function handleAuditEventDetail(eventId, { auditDir }) {
    return readAuditEvent({ dir: auditDir, eventId });
}
//# sourceMappingURL=audit-events.js.map