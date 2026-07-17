import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');

async function replaceOnce(relativePath, before, after) {
  const path = resolve(root, relativePath);
  const current = await readFile(path, 'utf-8');
  if (current.includes(after)) return;
  if (!current.includes(before)) throw new Error(`Patch anchor not found in ${relativePath}`);
  await writeFile(path, current.replace(before, after), 'utf-8');
}

await replaceOnce(
  'ops-room/src/services/runtime-paths.ts',
  `export const OPERATOR_TOKEN = process.env.OPS_ROOM_OPERATOR_TOKEN || '';
export const ISSUE_POLLING_ENABLED`,
  `export const OPERATOR_TOKEN = process.env.OPS_ROOM_OPERATOR_TOKEN || '';
export const OPERATOR_ID = process.env.OPS_ROOM_OPERATOR_ID || '';
export const OPERATOR_DISPLAY_NAME = process.env.OPS_ROOM_OPERATOR_DISPLAY_NAME || '';
export const ISSUE_POLLING_ENABLED`,
);

await replaceOnce(
  'ops-room/src/services/runtime-paths.ts',
  `export const STATE_DIR = process.env.OPS_ROOM_STATE_DIR || join(_opsRoomDataDir, 'state');
export const WORKSPACE_BASE`,
  `export const STATE_DIR = process.env.OPS_ROOM_STATE_DIR || join(_opsRoomDataDir, 'state');
export const AUDIT_DIR = process.env.OPS_ROOM_AUDIT_DIR || join(_opsRoomDataDir, 'audit');
export const IDEMPOTENCY_DIR = process.env.OPS_ROOM_IDEMPOTENCY_DIR || join(_opsRoomDataDir, 'idempotency');
export const WORKSPACE_BASE`,
);

await replaceOnce(
  'ops-room/src/services/task-store.ts',
  `import { TASKS_DIR, REVIEW_TASKS_DIR, STATE_DIR, LOCK_DIR, WORKSPACE_BASE, LOG_DIR, PROMPT_DIR } from './runtime-paths.js';`,
  `import { TASKS_DIR, REVIEW_TASKS_DIR, STATE_DIR, LOCK_DIR, WORKSPACE_BASE, LOG_DIR, PROMPT_DIR, AUDIT_DIR, IDEMPOTENCY_DIR } from './runtime-paths.js';`,
);

await replaceOnce(
  'ops-room/src/services/task-store.ts',
  `  await ensureDir(STATE_DIR);
  await ensureDir(LOCK_DIR);`,
  `  await ensureDir(STATE_DIR);
  await ensureDir(AUDIT_DIR);
  await ensureDir(IDEMPOTENCY_DIR);
  await ensureDir(LOCK_DIR);`,
);

await replaceOnce(
  'ops-room/src/routes/health.ts',
  `  TASKS_DIR, REVIEW_TASKS_DIR, STATE_DIR, LOG_DIR, WORKSPACE_BASE,
  OPENAB_SERVER_VERSION, REQUIRED_COMMANDS`,
  `  TASKS_DIR, REVIEW_TASKS_DIR, STATE_DIR, LOG_DIR, WORKSPACE_BASE, AUDIT_DIR, IDEMPOTENCY_DIR,
  OPENAB_SERVER_VERSION, REQUIRED_COMMANDS`,
);

await replaceOnce(
  'ops-room/src/routes/health.ts',
  `    ['log_store', directoryCheckFn(LOG_DIR)],
    ['workspace_store', directoryCheckFn(WORKSPACE_BASE)],`,
  `    ['log_store', directoryCheckFn(LOG_DIR)],
    ['audit_store', directoryCheckFn(AUDIT_DIR)],
    ['idempotency_store', directoryCheckFn(IDEMPOTENCY_DIR)],
    ['workspace_store', directoryCheckFn(WORKSPACE_BASE)],`,
);

await replaceOnce(
  'ops-room/src/routes/health.ts',
  `      logs_dir: LOG_DIR,
      workspaces_dir: WORKSPACE_BASE,`,
  `      logs_dir: LOG_DIR,
      audit_dir: AUDIT_DIR,
      idempotency_dir: IDEMPOTENCY_DIR,
      workspaces_dir: WORKSPACE_BASE,`,
);

await replaceOnce(
  'ops-room/scripts/deploy/preflight-host.ts',
  `  'OPS_ROOM_DATA_DIR',
  'OPS_ROOM_LOGS_DIR',`,
  `  'OPS_ROOM_DATA_DIR',
  'OPS_ROOM_AUDIT_DIR',
  'OPS_ROOM_IDEMPOTENCY_DIR',
  'OPS_ROOM_LOGS_DIR',`,
);

await replaceOnce(
  'ops-room/src/server/http.ts',
  `  REPO, PORT, HOST, WEBHOOK_SECRET, WORKSPACE_BASE, REVIEW_TASKS_DIR,
  OPENAB_SERVER_VERSION, OPERATOR_API_ENABLED, SHUTDOWN_TIMEOUT_MS, ISSUE_POLLING_ENABLED,`,
  `  REPO, PORT, HOST, WEBHOOK_SECRET, WORKSPACE_BASE, REVIEW_TASKS_DIR, AUDIT_DIR, IDEMPOTENCY_DIR,
  OPENAB_SERVER_VERSION, OPERATOR_API_ENABLED, SHUTDOWN_TIMEOUT_MS, ISSUE_POLLING_ENABLED,`,
);

await replaceOnce(
  'ops-room/src/server/http.ts',
  `import { handleStaticApp } from '../routes/static-app.js';
import { sendJSON, verifyAuth, verifyOperatorAuth, parseBody } from '../routes/helpers.js';`,
  `import { handleStaticApp } from '../routes/static-app.js';
import { handleOperatorTaskCancellation } from '../routes/operator-tasks.js';
import { handleAuditEventDetail, handleAuditEventsList } from '../routes/audit-events.js';
import { resolveOperatorIdentity } from '../services/operator-identity.js';
import { sendJSON, verifyAuth, verifyOperatorAuth, parseBody } from '../routes/helpers.js';`,
);

await replaceOnce(
  'ops-room/src/server/http.ts',
  `function requireOperatorMutation(req, res) {
  if (!OPERATOR_API_ENABLED) {
    sendJSON(res, 404, { error: 'Not found' });
    return false;
  }
  if (!verifyOperatorAuth(req.headers.authorization)) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}`,
  `function requireOperatorMutation(req, res) {
  if (!OPERATOR_API_ENABLED) {
    sendJSON(res, 404, { error: 'Not found' });
    return null;
  }
  if (!verifyOperatorAuth(req.headers.authorization)) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return null;
  }
  try {
    return resolveOperatorIdentity();
  } catch {
    sendJSON(res, 503, { error: 'Operator identity unavailable' });
    return null;
  }
}`,
);

await replaceOnce(
  'ops-room/src/server/http.ts',
  `  const reviewCancelMatch = pathname.match(/^\\/api\\/review-tasks\\/([A-Za-z0-9._:-]+)\\/cancel$/);`,
  `  const operatorCancelMatch = pathname.match(/^\\/api\\/operator\\/tasks\\/([A-Za-z0-9._:-]+)\\/cancel$/);
  if (req.method === 'POST' && operatorCancelMatch) {
    const actor = requireOperatorMutation(req, res);
    if (!actor) return;
    try {
      const body = await parseBody(req);
      const result = await handleOperatorTaskCancellation({
        taskId: operatorCancelMatch[1],
        body,
        actor,
        reviewTasksDir: REVIEW_TASKS_DIR,
        auditDir: AUDIT_DIR,
        idempotencyDir: IDEMPOTENCY_DIR,
      });
      sendJSON(res, result.status, result.body);
    } catch (error) {
      sendJSON(res, 500, { error: error?.message || 'Cancellation failed' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/audit-events') {
    if (!requireOperatorMutation(req, res)) return;
    const data = await handleAuditEventsList(searchParams, { auditDir: AUDIT_DIR });
    sendJSON(res, 200, data);
    return;
  }

  const auditDetailMatch = pathname.match(/^\\/api\\/audit-events\\/([A-Fa-f0-9-]+)$/);
  if (req.method === 'GET' && auditDetailMatch) {
    if (!requireOperatorMutation(req, res)) return;
    const event = await handleAuditEventDetail(auditDetailMatch[1], { auditDir: AUDIT_DIR });
    if (!event) sendJSON(res, 404, { error: 'Audit event not found' });
    else sendJSON(res, 200, { event });
    return;
  }

  const reviewCancelMatch = pathname.match(/^\\/api\\/review-tasks\\/([A-Za-z0-9._:-]+)\\/cancel$/);`,
);

await replaceOnce(
  'ops-room/src/server/http.ts',
  `  if (req.method === 'POST' && reviewCancelMatch) {
    if (!requireOperatorMutation(req, res)) return;
    try {
      const body = await parseBody(req);
      const task = await requestCancellation({
        dir: REVIEW_TASKS_DIR,
        id: reviewCancelMatch[1],
        actor: 'operator-api',`,
  `  if (req.method === 'POST' && reviewCancelMatch) {
    const actor = requireOperatorMutation(req, res);
    if (!actor) return;
    try {
      const body = await parseBody(req);
      const task = await requestCancellation({
        dir: REVIEW_TASKS_DIR,
        id: reviewCancelMatch[1],
        actor: actor.actor_id,`,
);

console.log('OPS-002 source integration applied');
