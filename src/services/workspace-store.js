import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const WORKSPACE_RECORD_VERSION = 1;
export const WORKSPACE_STATES = Object.freeze([
    'allocating',
    'active',
    'cleanup_requested',
    'cleaning',
    'released',
    'failed',
    'held_for_investigation',
]);
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_REPOSITORY_ID = /^(?:[A-Za-z0-9._-]{1,120}|[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
export function validateWorkspaceRecord(record) {
    if (!record || record.version !== WORKSPACE_RECORD_VERSION)
        throw new Error('unsupported_workspace_record');
    for (const field of ['workspace_id', 'owner_agent']) {
        if (!SAFE_ID.test(String(record[field] || '')))
            throw new Error(`invalid_${field}`);
    }
    if (!SAFE_TASK_ID.test(String(record.task_id || '')))
        throw new Error('invalid_task_id');
    if (!SAFE_REPOSITORY_ID.test(String(record.repository_id || '')))
        throw new Error('invalid_repository_id');
    if (!['branch', 'detached'].includes(record.mode))
        throw new Error('invalid_workspace_mode');
    if (!WORKSPACE_STATES.includes(record.state))
        throw new Error('invalid_workspace_state');
    if (record.mode === 'branch' && !record.branch)
        throw new Error('workspace_branch_required');
    if (record.requested_sha && !SAFE_SHA.test(record.requested_sha))
        throw new Error('invalid_requested_sha');
    if (record.resolved_sha && !SAFE_SHA.test(record.resolved_sha))
        throw new Error('invalid_resolved_sha');
    const relativePath = String(record.relative_path || '').replaceAll('\\', '/');
    if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/')) {
        throw new Error('invalid_workspace_relative_path');
    }
    return record;
}
function recordPath(dir, workspaceId) {
    if (!SAFE_ID.test(workspaceId))
        throw new Error('invalid_workspace_id');
    return join(dir, `${workspaceId}.json`);
}
export async function writeWorkspaceRecord({ dir, record, now = () => new Date().toISOString() }) {
    await mkdir(dir, { recursive: true });
    const next = validateWorkspaceRecord({
        ...record,
        version: WORKSPACE_RECORD_VERSION,
        updated_at: now(),
        created_at: record.created_at || now(),
    });
    const target = recordPath(dir, next.workspace_id);
    const temp = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, target);
    return next;
}
export async function readWorkspaceRecord({ dir, workspaceId }) {
    const raw = await readFile(recordPath(dir, workspaceId), 'utf8');
    return validateWorkspaceRecord(JSON.parse(raw));
}
export async function listWorkspaceRecords({ dir }) {
    await mkdir(dir, { recursive: true });
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    const records = [];
    for (const name of names) {
        try {
            records.push(validateWorkspaceRecord(JSON.parse(await readFile(join(dir, name), 'utf8'))));
        }
        catch {
            records.push({
                version: WORKSPACE_RECORD_VERSION,
                workspace_id: name.replace(/\.json$/, ''),
                state: 'failed',
                last_error: 'workspace_record_unavailable',
            });
        }
    }
    return records;
}
export async function updateWorkspaceRecord({ dir, workspaceId, patch, now }) {
    const current = await readWorkspaceRecord({ dir, workspaceId });
    return writeWorkspaceRecord({ dir, record: { ...current, ...patch, workspace_id: current.workspace_id }, now });
}
//# sourceMappingURL=workspace-store.js.map