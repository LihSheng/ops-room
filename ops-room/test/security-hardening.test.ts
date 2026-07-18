import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAB_WEBHOOK_SECRET = 'security-test-webhook';
process.env.OPS_ROOM_DASHBOARD_TOKEN = 'security-test-dashboard';

const { sendJSON, verifyDashboardAuth } = await import('../src/routes/helpers.js');
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

test('redacts common GitHub, AI, cloud, bearer, assignment, and private-key credentials', () => {
  const input = [
    'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz123456@github.com/LihSheng/ops-room.git',
    'Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz123456',
    'OPENCODE_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
    'NVIDIA_API_KEY=nvapi-abcdefghijklmnopqrstuvwxyz123456',
    'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
    'password="correct-horse-battery-staple"',
    '-----BEGIN PRIVATE KEY-----\nvery-private-material\n-----END PRIVATE KEY-----',
  ].join('\n');

  const output = redactSecrets(input);
  for (const secret of [
    'ghs_abcdefghijklmnopqrstuvwxyz123456',
    'github_pat_abcdefghijklmnopqrstuvwxyz123456',
    'sk-abcdefghijklmnopqrstuvwxyz123456',
    'nvapi-abcdefghijklmnopqrstuvwxyz123456',
    'AKIA1234567890ABCDEF',
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

test('operational API responses require dashboard authentication', () => {
  const unauthorized = captureJsonResponse({ url: '/api/health' }, { paths: { tasks_dir: '/private/path' } });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.body, { error: 'Unauthorized' });

  const authorized = captureJsonResponse(
    { url: '/api/health', authorization: 'Bearer security-test-dashboard' },
    { ready: true },
  );
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(authorized.body, { ready: true });
  assert.equal(authorized.headers['Cache-Control'], 'no-store');
});

test('basic health check remains public', () => {
  const response = captureJsonResponse({ url: '/health' }, { status: 'ok' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});
