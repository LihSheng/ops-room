import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.OPENAB_WEBHOOK_SECRET = 'dashboard-read-auth-webhook';
process.env.OPS_ROOM_DASHBOARD_TOKEN = 'dashboard-read-auth-dashboard';
process.env.OPS_ROOM_OPERATOR_API_ENABLED = 'true';
process.env.OPS_ROOM_OPERATOR_TOKEN = 'dashboard-read-auth-operator';

const {
  sendJSON,
  verifyAuth,
  verifyDashboardAuth,
  verifyDashboardReadRequest,
  verifyOperatorAuth,
} = await import('../src/routes/helpers.js');

const DASHBOARD_READ_ROUTES = [
  '/api/workflows',
  '/api/workflows/workflow:LihSheng-ops-room:1234567890abcdef12345678',
  '/api/review-tasks',
  '/api/review-tasks/pr-42-review',
  '/api/review-tasks/pr-42-review/effects',
];

function request(route: string, token = '', method = 'GET') {
  return {
    method,
    url: route,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

function captureJsonResponse(req: any, payload: any = { ok: true }) {
  let statusCode = 0;
  let body = '';
  const res = {
    req,
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

for (const route of DASHBOARD_READ_ROUTES) {
  test(`${route} accepts only the dashboard bearer token`, () => {
    assert.equal(verifyDashboardReadRequest(request(route, 'dashboard-read-auth-dashboard')), true);
    assert.equal(verifyDashboardReadRequest(request(route, 'dashboard-read-auth-webhook')), false);
    assert.equal(verifyDashboardReadRequest(request(route, 'dashboard-read-auth-operator')), false);
    assert.equal(verifyDashboardReadRequest(request(route)), false);
    assert.equal(verifyDashboardReadRequest(request(route, 'dashboard-read-auth-dashboard', 'POST')), false);
  });

  test(`${route} is protected by the central response guard`, () => {
    assert.equal(captureJsonResponse(request(route)).statusCode, 401);
    assert.equal(captureJsonResponse(request(route, 'dashboard-read-auth-webhook')).statusCode, 401);
    assert.equal(captureJsonResponse(request(route, 'dashboard-read-auth-operator')).statusCode, 401);
    assert.deepEqual(
      captureJsonResponse(request(route, 'dashboard-read-auth-dashboard'), { data: 'visible' }),
      { statusCode: 200, body: { data: 'visible' } },
    );
  });
}

test('webhook authentication remains isolated from dashboard and operator tokens', () => {
  assert.equal(verifyAuth('Bearer dashboard-read-auth-webhook'), true);
  assert.equal(verifyAuth('Bearer dashboard-read-auth-dashboard'), false);
  assert.equal(verifyAuth('Bearer dashboard-read-auth-operator'), false);
  assert.equal(verifyAuth(undefined), false);
});

test('dashboard authentication remains isolated from webhook and operator tokens', () => {
  assert.equal(verifyDashboardAuth('Bearer dashboard-read-auth-dashboard'), true);
  assert.equal(verifyDashboardAuth('Bearer dashboard-read-auth-webhook'), false);
  assert.equal(verifyDashboardAuth('Bearer dashboard-read-auth-operator'), false);
  assert.equal(verifyDashboardAuth(undefined), false);
});

test('operator authentication remains isolated from webhook and dashboard tokens', () => {
  assert.equal(verifyOperatorAuth('Bearer dashboard-read-auth-operator'), true);
  assert.equal(verifyOperatorAuth('Bearer dashboard-read-auth-webhook'), false);
  assert.equal(verifyOperatorAuth('Bearer dashboard-read-auth-dashboard'), false);
  assert.equal(verifyOperatorAuth(undefined), false);
});

test('compiled server wiring uses dashboard auth for reads and webhook auth for ingress', async () => {
  const source = await readFile(new URL('../src/server/http.js', import.meta.url), 'utf8');
  assert.equal((source.match(/verifyDashboardReadRequest\(req\)/g) || []).length, 5);

  const webhookStart = source.indexOf("req.method === 'POST' && pathname === '/webhook'");
  assert.notEqual(webhookStart, -1);
  const webhookBlock = source.slice(webhookStart, webhookStart + 500);
  assert.match(webhookBlock, /verifyAuth\(auth\)/);
  assert.doesNotMatch(webhookBlock, /verifyDashboardReadRequest/);
});
