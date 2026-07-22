import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENAB_WEBHOOK_SECRET = 'dashboard-read-auth-webhook';
process.env.OPS_ROOM_DASHBOARD_TOKEN = 'dashboard-read-auth-dashboard';
process.env.OPS_ROOM_OPERATOR_API_ENABLED = 'true';
process.env.OPS_ROOM_OPERATOR_TOKEN = 'dashboard-read-auth-operator';
process.env.OPS_ROOM_HUMAN_AUTH_ENABLED = 'true';

const {
  sendJSON,
  verifyAuth,
  verifyDashboardAuth,
  verifyDashboardReadRequest,
  verifyOperatorAuth,
} = await import('../src/routes/helpers.js');
const { authorizeDashboardReadRequest } = await import('../src/services/dashboard-request-auth.js');
const { listAuditEvents } = await import('../src/services/audit-log.js');
const { createOperatorSession } = await import('../src/services/operator-session-store.js');

const DASHBOARD_READ_ROUTES = [
  '/api/health',
  '/api/tasks',
  '/api/logs?agent=professor',
  '/api/agents',
  '/api/openab/instances',
  '/api/agents/profiles',
  '/api/skills',
  '/api/memory-spaces',
  '/api/workflows',
  '/api/workflows/workflow:LihSheng-ops-room:1234567890abcdef12345678',
  '/api/review-tasks',
  '/api/review-tasks/pr-42-review',
  '/api/review-tasks/pr-42-review/effects',
];

const ACTOR = Object.freeze({
  actor_type: 'human_operator',
  actor_id: 'viewer-1',
  actor_display_name: 'Viewer One',
  auth_method: 'operator_token',
});

function request(route: string, { token = '', cookie = '', method = 'GET' } = {}) {
  return {
    method,
    url: route,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
  };
}

function captureJsonResponse(payload: any = { ok: true }) {
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(status: number) {
      statusCode = status;
    },
    end(value: unknown) {
      body = String(value || '');
    },
  };
  sendJSON(res, 200, payload);
  return { statusCode, body: JSON.parse(body) };
}

async function sessionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-dashboard-session-'));
  const sessionDir = join(root, 'sessions');
  const auditDir = join(root, 'audit');
  const token = 's'.repeat(43);
  const created = await createOperatorSession({
    dir: sessionDir,
    actor: ACTOR,
    roles: ['viewer'],
    ttlSeconds: 3600,
    generateToken: () => token,
    now: () => '2026-07-22T00:00:00.000Z',
  });
  return { root, sessionDir, auditDir, token, session: created.session };
}

for (const route of DASHBOARD_READ_ROUTES) {
  test(`${route} keeps the synchronous V1 dashboard-token verifier isolated`, () => {
    assert.equal(verifyDashboardReadRequest(request(route, { token: 'dashboard-read-auth-dashboard' })), true);
    assert.equal(verifyDashboardReadRequest(request(route, { token: 'dashboard-read-auth-webhook' })), false);
    assert.equal(verifyDashboardReadRequest(request(route, { token: 'dashboard-read-auth-operator' })), false);
    assert.equal(verifyDashboardReadRequest(request(route)), false);
    assert.equal(verifyDashboardReadRequest(request(route, { token: 'dashboard-read-auth-dashboard', method: 'POST' })), false);
  });
}

test('asynchronous dashboard authorization preserves the dedicated bearer path', async () => {
  const accepted = await authorizeDashboardReadRequest({
    req: request('/api/health', { token: 'dashboard-read-auth-dashboard' }),
    humanAuthEnabled: false,
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.auth_method, 'dashboard_token');

  for (const token of ['dashboard-read-auth-webhook', 'dashboard-read-auth-operator']) {
    const rejected = await authorizeDashboardReadRequest({
      req: request('/api/health', { token }),
      humanAuthEnabled: false,
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.status, 401);
  }
});

test('valid human session with dashboard.read authorizes protected reads', async () => {
  const fixture = await sessionFixture();
  const result = await authorizeDashboardReadRequest({
    req: request('/api/tasks', { cookie: `ops_room_session=${fixture.token}` }),
    humanAuthEnabled: true,
    sessionDir: fixture.sessionDir,
    auditDir: fixture.auditDir,
    verifyDashboardBearer: () => false,
    now: () => '2026-07-22T00:10:00.000Z',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.auth_method, 'operator_session');
  assert.equal(result.actor?.actor_id, ACTOR.actor_id);
  assert.equal(result.actor?.session_id, fixture.session.session_id);
});

test('valid session without dashboard.read is forbidden and audited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-dashboard-denial-'));
  const auditDir = join(root, 'audit');
  const result = await authorizeDashboardReadRequest({
    req: request('/api/tasks', { cookie: `ops_room_session=${'x'.repeat(43)}` }),
    humanAuthEnabled: true,
    auditDir,
    verifyDashboardBearer: () => false,
    readSession: async () => ({
      session_id: 'session:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      actor: ACTOR,
      roles: [],
      created_at: '2026-07-22T00:00:00.000Z',
      expires_at: '2026-07-22T01:00:00.000Z',
    }),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(result.error_code, 'operator_permission_denied');

  const events = await listAuditEvents({ dir: auditDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'operator.authorization.denied');
  assert.equal(events[0].actor.session_id, 'session:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(events[0].target.id, 'dashboard.read');
  assert.deepEqual(events[0].metadata, { method: 'GET', path: '/api/tasks' });
});

test('dashboard session-store outage fails closed with bounded unavailable response', async () => {
  const result = await authorizeDashboardReadRequest({
    req: request('/api/tasks', { cookie: `ops_room_session=${'x'.repeat(43)}` }),
    humanAuthEnabled: true,
    verifyDashboardBearer: () => false,
    readSession: async () => { throw new Error('store unavailable'); },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 503,
    error: 'Operator session unavailable',
    error_code: 'operator_session_unavailable',
  });
});

test('sendJSON is a pure response writer after pre-route dashboard authorization', () => {
  assert.deepEqual(
    captureJsonResponse({ data: 'visible' }),
    { statusCode: 200, body: { data: 'visible' } },
  );
});

test('service credential authentication remains separated', () => {
  assert.equal(verifyAuth('Bearer dashboard-read-auth-webhook'), true);
  assert.equal(verifyAuth('Bearer dashboard-read-auth-dashboard'), false);
  assert.equal(verifyAuth('Bearer dashboard-read-auth-operator'), false);

  assert.equal(verifyDashboardAuth('Bearer dashboard-read-auth-dashboard'), true);
  assert.equal(verifyDashboardAuth('Bearer dashboard-read-auth-webhook'), false);
  assert.equal(verifyDashboardAuth('Bearer dashboard-read-auth-operator'), false);

  assert.equal(verifyOperatorAuth('Bearer dashboard-read-auth-operator'), true);
  assert.equal(verifyOperatorAuth('Bearer dashboard-read-auth-webhook'), false);
  assert.equal(verifyOperatorAuth('Bearer dashboard-read-auth-dashboard'), false);
});

test('compiled server uses one asynchronous dashboard guard and isolated webhook auth', async () => {
  const source = await readFile(new URL('../src/server/http.js', import.meta.url), 'utf8');
  assert.equal((source.match(/requiresDashboardReadAuth\(req\)/g) || []).length, 1);
  assert.equal((source.match(/authorizeDashboardReadRequest\(\{ req \}\)/g) || []).length, 1);
  assert.equal((source.match(/verifyDashboardReadRequest\(req\)/g) || []).length, 0);

  const webhookMatch = source.match(/p\s*===\s*'\/webhook'/);
  assert.ok(webhookMatch, 'webhook route present in compiled output');
  const webhookIdx = webhookMatch.index;
  assert.notEqual(webhookIdx, -1);
  const webhookBlock = source.slice(webhookIdx, webhookIdx + 700);
  assert.match(webhookBlock, /verifyAuth\(auth\)/);
  assert.doesNotMatch(webhookBlock, /authorizeDashboardReadRequest/);
});
