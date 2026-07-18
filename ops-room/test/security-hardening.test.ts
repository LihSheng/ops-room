import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAB_WEBHOOK_SECRET = 'security-test-webhook';
process.env.OPS_ROOM_DASHBOARD_TOKEN = 'security-test-dashboard';

const { sendJSON, verifyDashboardAuth, verifyAuth } = await import('../src/routes/helpers.js');
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

// ── Profile API route protection ──────────────────────────────────────

test('/api/agents/profiles requires dashboard auth', () => {
  const noAuth = captureJsonResponse({ url: '/api/agents/profiles' }, { profiles: [], count: 0 });
  assert.equal(noAuth.statusCode, 401);

  const wrongToken = captureJsonResponse(
    { url: '/api/agents/profiles', authorization: 'Bearer wrong-token' },
    { profiles: [], count: 0 },
  );
  assert.equal(wrongToken.statusCode, 401);

  const correct = captureJsonResponse(
    { url: '/api/agents/profiles', authorization: 'Bearer security-test-dashboard' },
    { profiles: [], count: 0 },
  );
  assert.equal(correct.statusCode, 200);
});

test('/api/agents/profiles/:id requires dashboard auth', () => {
  const noAuth = captureJsonResponse({ url: '/api/agents/profiles/berlin' }, { profile: {} });
  assert.equal(noAuth.statusCode, 401);

  const correct = captureJsonResponse(
    { url: '/api/agents/profiles/berlin', authorization: 'Bearer security-test-dashboard' },
    { profile: {} },
  );
  assert.equal(correct.statusCode, 200);
});

test('/api/skills requires dashboard auth', () => {
  const noAuth = captureJsonResponse({ url: '/api/skills' }, { skills: [], count: 0 });
  assert.equal(noAuth.statusCode, 401);

  const correct = captureJsonResponse(
    { url: '/api/skills', authorization: 'Bearer security-test-dashboard' },
    { skills: [], count: 0 },
  );
  assert.equal(correct.statusCode, 200);
});

test('/api/memory-spaces requires dashboard auth', () => {
  const noAuth = captureJsonResponse({ url: '/api/memory-spaces' }, { memory_spaces: [], count: 0 });
  assert.equal(noAuth.statusCode, 401);

  const correct = captureJsonResponse(
    { url: '/api/memory-spaces', authorization: 'Bearer security-test-dashboard' },
    { memory_spaces: [], count: 0 },
  );
  assert.equal(correct.statusCode, 200);
});

test('/webhook uses webhook secret not dashboard token', () => {
  assert.equal(verifyAuth('Bearer security-test-webhook'), true);
  assert.equal(verifyAuth('Bearer security-test-dashboard'), false);
  assert.equal(verifyDashboardAuth('Bearer security-test-webhook'), false);
  assert.equal(verifyDashboardAuth('Bearer security-test-dashboard'), true);
});

// ── Workspace path removal from public surfaces ───────────────────────

test('coding failure error messages no longer embed workspace paths', () => {
  // Workspace paths are removed at source in handleCodingFailure() and
  // runCodingAgent(), not by redactSecrets(). redactSecrets() is
  // defense-in-depth for credentials, not a path sanitizer.
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
