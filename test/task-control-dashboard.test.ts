import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CLIENT_FILE = new URL('../dashboard/src/api/operator-tasks.ts', import.meta.url);
const COMPONENT_FILE = new URL('../dashboard/src/components/TaskControlDesk.tsx', import.meta.url);
const ROUTE_FILE = new URL('../src/routes/operator-tasks.ts', import.meta.url);

 test('browser client exposes only accepted review-task state transitions', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8');
  assert.match(source, /pause: new Set\(\['QUEUED', 'FIX_QUEUED'\]\)/);
  assert.match(source, /resume: new Set\(\['PAUSED'\]\)/);
  assert.match(source, /cancel: new Set\(\['QUEUED', 'FIX_QUEUED', 'CLAIMED', 'RUNNING', 'FIXING'\]\)/);
  assert.match(source, /retry: new Set\(\['ERROR', 'NEEDS_HUMAN', 'SUPERSEDED', 'CANCELLED'\]\)/);
  assert.match(source, /availableReviewTaskActions/);
});

test('task actions call the existing operator route with CSRF, reason, and idempotency', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8');
  assert.match(source, /\/api\/operator\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/\$\{action\}/);
  assert.match(source, /method: 'POST'/);
  assert.match(source, /'X-Ops-Room-CSRF': csrfToken/);
  assert.match(source, /reason,/);
  assert.match(source, /idempotency_key: idempotencyKey/);
  assert.match(source, /browser-task:/);
  assert.doesNotMatch(source, /workflow|effects\/.+resolve|workspace|provider/i);
});

test('control desk requires a reason and explicit confirmation while retaining uncertain request identity', async () => {
  const source = await readFile(COMPONENT_FILE, 'utf8');
  assert.match(source, /label="Operator reason"/);
  assert.match(source, /<Checkbox/);
  assert.match(source, /I confirm the/);
  assert.match(source, /same idempotency key is retained/);
  assert.match(source, /Request key <Code>\{pending\.idempotencyKey\}<\/Code>/);
  assert.match(source, /disabled=\{!confirmed \|\| !reason\.trim\(\)/);
  assert.match(source, /roles\.includes\('operator'\) \|\| roles\.includes\('administrator'\)/);
  assert.match(source, /Dashboard-token mode remains read only/);
});

test('successful task actions refresh every affected read projection', async () => {
  const source = await readFile(COMPONENT_FILE, 'utf8');
  for (const key of ['review-tasks', 'interventions', 'ops-dashboard', 'mission-room', 'agent-fleet']) {
    assert.match(source, new RegExp(`\\['${key}'\\]`));
  }
  assert.match(source, /idempotent_replay/);
  assert.match(source, /audit_event_id/);
});

test('server remains authoritative for transition, idempotency, dispatch, and audit', async () => {
  const source = await readFile(ROUTE_FILE, 'utf8');
  assert.match(source, /executeIdempotent/);
  assert.match(source, /withTaskActionLock/);
  assert.match(source, /appendAuditEvent/);
  assert.match(source, /definition\.mutate/);
  assert.match(source, /dispatch: !result\.replayed/);
  assert.match(source, /retry_budget_exhausted/);
});
