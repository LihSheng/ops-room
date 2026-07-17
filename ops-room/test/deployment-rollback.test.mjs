import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildReleaseArtifact } from '../scripts/deploy/release-artifact.mjs';

const windows = process.platform === 'win32';
const scriptRoot = resolve(fileURLToPath(new URL('../scripts/deploy/', import.meta.url)));

function run(command, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function makeSource(root) {
  await mkdir(join(root, 'src', 'server'), { recursive: true });
  await mkdir(join(root, 'dist', 'dashboard'), { recursive: true });
  await writeFile(join(root, 'src', 'server', 'webhook.mjs'), 'console.log("release");\n');
  await writeFile(join(root, 'dist', 'dashboard', 'index.html'), '<!doctype html>\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', engines: { node: '>=20' } }));
}

test('manual activation and rollback switch immutable release links', { skip: windows && 'Linux deployment contract' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ops-room-deploy-test-'));
  const source = join(temp, 'source');
  const artifacts = join(temp, 'artifacts');
  const installRoot = join(temp, 'install');
  const fakeSystemctl = join(temp, 'systemctl');
  const fakeCurl = join(temp, 'curl');
  const firstSha = '1'.repeat(40);
  const secondSha = '2'.repeat(40);
  try {
    await makeSource(source);
    await writeFile(fakeSystemctl, '#!/usr/bin/env bash\nexit 0\n');
    await writeFile(fakeCurl, `#!/usr/bin/env bash
node -e '
  const fs = require("fs");
  const path = require("path");
  const root = process.env.OPS_ROOM_INSTALL_ROOT;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "current", "RELEASE.json"), "utf8"));
  process.stdout.write(JSON.stringify({
    ready: true,
    revision: manifest.commit_sha,
    lifecycle: { operations: process.env.OPS_ROOM_FAKE_ACTIVE === "1" ? ["legacy-issue:coder#42"] : [] },
  }));
'
`);
    await chmod(fakeSystemctl, 0o755);
    await chmod(fakeCurl, 0o755);
    const first = await buildReleaseArtifact({ sourceRoot: source, outputDir: artifacts, commitSha: firstSha });
    const second = await buildReleaseArtifact({ sourceRoot: source, outputDir: artifacts, commitSha: secondSha });
    const env = {
      OPS_ROOM_INSTALL_ROOT: installRoot,
      OPS_ROOM_SYSTEMCTL_BIN: fakeSystemctl,
      OPS_ROOM_CURL_BIN: fakeCurl,
      OPS_ROOM_HEALTH_URL: 'http://unused.test/api/health',
    };

    assert.equal((await run('bash', [join(scriptRoot, 'activate-release.sh'), first.archivePath, first.checksumPath, firstSha], env)).code, 0);
    assert.equal((await run('bash', [join(scriptRoot, 'activate-release.sh'), second.archivePath, second.checksumPath, secondSha], env)).code, 0);
    assert.equal(await readlink(join(installRoot, 'current')), `releases/${secondSha}`);

    const releasedServer = join(installRoot, 'releases', secondSha, 'ops-room', 'src', 'server', 'webhook.mjs');
    await writeFile(releasedServer, 'tampered\n');
    const tampered = await run('bash', [join(scriptRoot, 'activate-release.sh'), second.archivePath, second.checksumPath, secondSha], env);
    assert.equal(tampered.code, 65, tampered.stderr);
    await writeFile(releasedServer, 'console.log("release");\n');

    const blocked = await run('bash', [join(scriptRoot, 'activate-release.sh'), first.archivePath, first.checksumPath, firstSha], {
      ...env,
      OPS_ROOM_FAKE_ACTIVE: '1',
    });
    assert.equal(blocked.code, 75, blocked.stderr);
    assert.equal(await readlink(join(installRoot, 'current')), `releases/${secondSha}`);

    const rollback = await run('bash', [join(scriptRoot, 'rollback-release.sh')], env);
    assert.equal(rollback.code, 0, rollback.stderr);
    assert.equal(await readlink(join(installRoot, 'current')), `releases/${firstSha}`);
    assert.equal(await readlink(join(installRoot, 'previous')), `releases/${secondSha}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
