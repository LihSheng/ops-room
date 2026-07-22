import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAB_WEBHOOK_SECRET = 'security-test-webhook';
process.env.OPS_ROOM_DASHBOARD_TOKEN = 'security-test-dashboard';

const { sendJSON, verifyDashboardAuth, verifyAuth } = await import('../src/routes/helpers.js');
const { authorizeDashboardReadRequest } = await import('../src/services/dashboard-request-auth.js');
const { redactSecrets } = await import('../src/services/security-redaction.js');

function captureJsonResponse({ url, authorization = '' }, payload = { ok: true }) {
  let statusCode = 0;
  let headers = {};
  let body = '';
  const res = {
    req: {
      method: 'GET',
      url,
      headers: authorization ? { authorization } : {},
    },
    writeHead(status, responseHeaders) {
      statusCode = status;
      headers = responseHeaders;
    },
    end(value) {
      body = String(value || '');
    },
  };

  sendJSON(res, 200, payload);
  return { statusCode, headers, body: JSON.parse(body) };
}

async function authorizeDashboard(url, authorization = '') {
  return authorizeDashboardReadRequest({
    req: {
      method: 'GET',
      url,
      headers: authorization ? { authorization } : {},
    },
    humanAuthEnabled: false,
  });
}

test('redacts common GitHub, AI, cloud, bearer, assignment, and private-key credentials', () => {
  const input = [
    'https://x-access-token:secret-ghs_abc123@github.com/owner/repo.git',
    'Authorization: Bearer sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'OPENCODE_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789',
    'NVIDIA_API_KEY=nvapi-abcdefghijklmnopqrstuvwxyz123456',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'password="correct-horse-battery-staple"',
    '[REDACTED PRIVATE KEY]',
  ].join('\n');

  const output = redactSecrets(input);
  for (const secret of [
    'secret-ghs_abc123',
    'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    'nvapi-abcdefghijklmnopqrstuvwxyz123456',
    'AKIAIOSFODNN7EXAMPLE',
    'correct-horse-battery-staple',
    'very-private-material',
  ]) {
    assert.equal(output.includes(secret), false, `secret remained visible: ${secret}`);
  }
  assert.match(output, /REDACTED/);
});

test('dashboard bearer comparison rejects missing and incorrect tokens', () => {
  assert.equal(verifyDashboardAuth(undefined), false);
  assert.equal(verifyDashboardAuth('Bearer wrong-token'), false);
  assert.equal(verifyDashboardAuth('Bearer security-test-dashboard'), true);
});

test('operational API requests require pre-route dashboard authorization', async () => {
  const unauthorized = await authorizeDashboard('/api/health');
  assert.equal(unauthorized.ok, false);
  if (!unauthorized.ok) {
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.error_code, 'dashboard_auth_required');
  }

  const authorized = await authorizeDashboard('/api/health', 'Bearer security-test-dashboard');
  assert.equal(authorized.ok, true);
  if (authorized.ok) assert.equal(authorized.auth_method, 'dashboard_token');

  const response = captureJsonResponse(
    { url: '/api/health', authorization: 'Bearer security-test-dashboard' },
    { ready: true },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ready: true });
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('basic health check remains public', () => {
  const response = captureJsonResponse({ url: '/health' }, { status: 'ok' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

// ── Profile and policy API route protection ────────────────────────────

for (const route of [
  '/api/agents/profiles',
  '/api/agents/profiles/berlin',
  '/api/skills',
  '/api/skills/pull-request-review/1.0.0',
  '/api/memory-spaces',
  '/api/memory-spaces/ops-room-project',
]) {
  test(`${route} requires dashboard auth`, async () => {
    const noAuth = await authorizeDashboard(route);
    assert.equal(noAuth.ok, false);
    if (!noAuth.ok) assert.equal(noAuth.status, 401);

    const wrong = await authorizeDashboard(route, 'Bearer wrong-token');
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.status, 401);

    const correct = await authorizeDashboard(route, 'Bearer security-test-dashboard');
    assert.equal(correct.ok, true);
  });
}

test('/webhook uses webhook secret not dashboard token', () => {
  assert.equal(verifyAuth('Bearer security-test-webhook'), true);
  assert.equal(verifyAuth('Bearer security-test-dashboard'), false);
  assert.equal(verifyDashboardAuth('Bearer security-test-webhook'), false);
  assert.equal(verifyDashboardAuth('Bearer security-test-dashboard'), true);
});

// ── Workspace path removal from public surfaces ───────────────────────

test('coding failure error messages no longer embed workspace paths', () => {
  const messageWithoutPath = 'Coding command failed.\nBackend: opencode\nExit code: 1\nstderr: error\nstdout: empty';
  assert.doesNotMatch(messageWithoutPath, /\/data\/workspaces\//);
});

test('console output redaction covers x-access-token URLs', () => {
  const input = 'Fetching from https://x-access-token:fake_installation_token_12345@github.com/LihSheng/repo.git';
  const output = redactSecrets(input);
  assert.equal(output.includes('fake_installation_token_12345'), false);
  assert.match(output, /REDACTED/);
  assert.equal(output.includes('github.com/LihSheng/repo.git'), true);
});

// ── redactSecrets covers multiple credential types ────────────────────

test('redactSecrets removes OpenAI API keys', () => {
  const input = 'Using API key sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz0123456789';
  const output = redactSecrets(input);
  assert.equal(output.includes('sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz0123456789'), false);
  assert.match(output, /REDACTED/);
});

test('redactSecrets removes GitHub PATs', () => {
  const input = 'Token: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdefghijklmnopq';
  const output = redactSecrets(input);
  assert.equal(output.includes('github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), false);
  assert.match(output, /REDACTED/);
});

test('redactSecrets removes bearer tokens', () => {
  const input = 'Authorization: Bearer ghs_secret_token_value_here_12345';
  const output = redactSecrets(input);
  assert.equal(output.includes('ghs_secret_token_value_here_12345'), false);
  assert.match(output, /REDACTED/);
});

test('redactSecrets removes secret assignments', () => {
  const input = 'api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789';
  const output = redactSecrets(input);
  assert.equal(output.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), false);
  assert.match(output, /REDACTED/);
});

// ── Authentication test coverage for all operational API roots ────────

const PROTECTED_ROUTES = [
  '/api/health',
  '/api/tasks',
  '/api/logs',
  '/api/agents',
  '/api/openab/instances',
  '/api/agents/profiles',
  '/api/skills',
  '/api/memory-spaces',
];

for (const route of PROTECTED_ROUTES) {
  test(`${route}: missing credentials are rejected`, async () => {
    const result = await authorizeDashboard(route);
    assert.equal(result.ok, false, `${route} should reject missing credentials`);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.error, 'Unauthorized');
    }
  });

  test(`${route}: incorrect dashboard token is rejected`, async () => {
    const result = await authorizeDashboard(route, 'Bearer definitely-wrong-token');
    assert.equal(result.ok, false, `${route} should reject the wrong token`);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.error, 'Unauthorized');
    }
  });

  test(`${route}: correct dashboard token authorizes the read`, async () => {
    const result = await authorizeDashboard(route, 'Bearer security-test-dashboard');
    assert.equal(result.ok, true, `${route} should accept the correct dashboard token`);
    if (result.ok) assert.equal(result.auth_method, 'dashboard_token');
  });
}
