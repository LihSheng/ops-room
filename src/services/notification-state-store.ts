import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeAtomic } from './review-task-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const NOTIFICATION_STATE_SCHEMA = 'ops-room.operator-notification-state.v1';
const SAFE_NOTIFICATION_ID = /^notification:[a-f0-9]{40}$/;
const NOTIFICATION_STATES = new Set(['read', 'acknowledged']);
const MAX_ENTRIES = 10_000;
const LOCK_STALE_MS = 10 * 60 * 1000;

function digest(value: unknown) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function validateActorId(value: unknown) {
  const actorId = bounded(value, 100);
  if (!actorId || /[\u0000-\u001f\u007f]/.test(actorId)) throw new Error('notification_actor_id_invalid');
  return actorId;
}

function validateNotificationId(value: unknown) {
  const notificationId = bounded(value, 80);
  if (!SAFE_NOTIFICATION_ID.test(notificationId)) throw new Error('notification_id_invalid');
  return notificationId;
}

function validateActivityId(value: unknown) {
  const activityId = bounded(value, 420);
  if (!activityId || /[\u0000-\u001f\u007f]/.test(activityId)) throw new Error('notification_activity_id_invalid');
  return activityId;
}

function validateTimestamp(value: unknown, field: string) {
  const timestamp = bounded(value, 64);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw new Error(`notification_${field}_invalid`);
  return timestamp;
}

function statePath(dir: string, actorId: string) {
  return join(dir, `operator-${digest(validateActorId(actorId))}.json`);
}

function lockName(actorId: string) {
  return `notification-${digest(validateActorId(actorId)).slice(0, 48)}`;
}

function newRecord(actorId: string, at: string) {
  return {
    schema: NOTIFICATION_STATE_SCHEMA,
    actor_id: actorId,
    entries: {},
    created_at: at,
    updated_at: at,
  };
}

export function validateNotificationStateRecord(record: any) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('notification_state_record_invalid');
  if (record.schema !== NOTIFICATION_STATE_SCHEMA) throw new Error('notification_state_schema_invalid');
  validateActorId(record.actor_id);
  validateTimestamp(record.created_at, 'created_at');
  validateTimestamp(record.updated_at, 'updated_at');
  if (!record.entries || typeof record.entries !== 'object' || Array.isArray(record.entries)) {
    throw new Error('notification_state_entries_invalid');
  }
  const entries = Object.entries(record.entries);
  if (entries.length > MAX_ENTRIES) throw new Error('notification_state_capacity_exceeded');
  for (const [key, raw] of entries) {
    const entry: any = raw;
    const notificationId = validateNotificationId(entry?.notification_id);
    if (key !== notificationId) throw new Error('notification_state_entry_key_invalid');
    validateActivityId(entry.activity_id);
    if (!NOTIFICATION_STATES.has(entry.state)) throw new Error('notification_state_value_invalid');
    validateTimestamp(entry.read_at, 'read_at');
    validateTimestamp(entry.updated_at, 'entry_updated_at');
    if (entry.state === 'acknowledged') {
      validateTimestamp(entry.acknowledged_at, 'acknowledged_at');
      if (!bounded(entry.acknowledgement_reason, 500)) throw new Error('notification_acknowledgement_reason_invalid');
    } else if (entry.acknowledged_at || entry.acknowledgement_reason) {
      throw new Error('notification_read_acknowledgement_evidence_invalid');
    }
  }
  return record;
}

export async function readOperatorNotificationState({
  dir,
  actorId,
  now = () => new Date().toISOString(),
}: {
  dir: string;
  actorId: string;
  now?: () => string;
}) {
  const normalizedActorId = validateActorId(actorId);
  try {
    const record = JSON.parse(await readFile(statePath(dir, normalizedActorId), 'utf-8'));
    validateNotificationStateRecord(record);
    if (record.actor_id !== normalizedActorId) throw new Error('notification_state_actor_mismatch');
    return record;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return newRecord(normalizedActorId, now());
    throw error;
  }
}

export function notificationStateFor(record: any, notificationId: unknown) {
  if (!record || typeof record !== 'object' || !record.entries || typeof record.entries !== 'object') {
    throw new Error('notification_state_record_invalid');
  }
  const normalizedId = validateNotificationId(notificationId);
  const entry = record.entries[normalizedId];
  if (!entry) {
    return {
      state: 'unread' as const,
      read_at: null,
      acknowledged_at: null,
      acknowledgement_reason: null,
    };
  }
  return {
    state: entry.state as 'read' | 'acknowledged',
    read_at: entry.read_at,
    acknowledged_at: entry.acknowledged_at || null,
    acknowledgement_reason: entry.acknowledgement_reason || null,
  };
}

async function updateNotificationState({
  dir,
  actorId,
  notificationId,
  activityId,
  action,
  reason,
  now,
}: {
  dir: string;
  actorId: string;
  notificationId: string;
  activityId: string;
  action: 'read' | 'acknowledge';
  reason?: string | null;
  now: () => string;
}) {
  const normalizedActorId = validateActorId(actorId);
  const normalizedNotificationId = validateNotificationId(notificationId);
  const normalizedActivityId = validateActivityId(activityId);
  const acknowledgementReason = action === 'acknowledge' ? bounded(reason, 500) : '';
  if (action === 'acknowledge' && !acknowledgementReason) throw new Error('notification_acknowledgement_reason_required');

  return withWorkspaceLock({
    dir: join(dir, '.locks'),
    name: lockName(normalizedActorId),
    staleAfterMs: LOCK_STALE_MS,
    execute: async () => {
      const record = await readOperatorNotificationState({ dir, actorId: normalizedActorId, now });
      const existing = record.entries[normalizedNotificationId];
      if (existing && existing.activity_id !== normalizedActivityId) throw new Error('notification_state_activity_conflict');

      if (existing?.state === 'acknowledged' || (action === 'read' && existing?.state === 'read')) {
        return { record, entry: existing, idempotent: true };
      }
      if (!existing && Object.keys(record.entries).length >= MAX_ENTRIES) {
        throw new Error('notification_state_capacity_exceeded');
      }

      const at = now();
      const entry = action === 'acknowledge'
        ? {
            notification_id: normalizedNotificationId,
            activity_id: normalizedActivityId,
            state: 'acknowledged',
            read_at: existing?.read_at || at,
            acknowledged_at: at,
            acknowledgement_reason: acknowledgementReason,
            updated_at: at,
          }
        : {
            notification_id: normalizedNotificationId,
            activity_id: normalizedActivityId,
            state: 'read',
            read_at: at,
            acknowledged_at: null,
            acknowledgement_reason: null,
            updated_at: at,
          };
      const updated = validateNotificationStateRecord({
        ...record,
        entries: { ...record.entries, [normalizedNotificationId]: entry },
        updated_at: at,
      });
      await writeAtomic(statePath(dir, normalizedActorId), updated);
      return { record: updated, entry, idempotent: false };
    },
  });
}

export async function markOperatorNotificationRead(input: Omit<Parameters<typeof updateNotificationState>[0], 'action' | 'reason'>) {
  return updateNotificationState({ ...input, action: 'read' });
}

export async function acknowledgeOperatorNotification(input: Omit<Parameters<typeof updateNotificationState>[0], 'action'>) {
  return updateNotificationState({ ...input, action: 'acknowledge' });
}
