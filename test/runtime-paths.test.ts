import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cwd, execPath } from 'node:process';

/**
 * The pure resolver function being tested.
 * resolveConfigRoot(candidateRoot) checks:
 *   1. candidate/config/agent-profiles/ exists as directory → return candidate
 *   2. parent(candidate)/config/agent-profiles/ exists as directory → return parent
 *   3. Otherwise → throw clear error listing both checked paths
 */
const { _resolveConfigRootForTest } = await import('../src/services/runtime-paths.js');

interface Layout {
  root: string;
  cleanup: () => void;
}

function s(): string {
  return Math.random().toString(36).slice(2, 6);
}

function createSourceCheckoutLayout(): Layout {
  const root = join(tmpdir(), `rpt-src-${Date.now()}-${s()}`);
  for (const sub of ['agent-profiles', 'skills', 'memory-spaces', 'agents']) {
    mkdirSync(join(root, 'config', sub), { recursive: true });
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function createImmutableReleaseLayout(): Layout {
  const releaseRoot = join(tmpdir(), `rpt-rel-${Date.now()}-${s()}`);
  for (const sub of ['agent-profiles', 'skills', 'memory-spaces', 'agents']) {
    mkdirSync(join(releaseRoot, 'config', sub), { recursive: true });
  }
  mkdirSync(join(releaseRoot, 'ops-room'), { recursive: true });
  return {
    root: join(releaseRoot, 'ops-room'),
    cleanup: () => rmSync(releaseRoot, { recursive: true, force: true }),
  };
}

function createNoConfigLayout(): Layout {
  const root = join(tmpdir(), `rpt-nocfg-${Date.now()}-${s()}`);
  mkdirSync(root, { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function createFileNotDirLayout(): Layout {
  const root = join(tmpdir(), `rpt-file-${Date.now()}-${s()}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config'), 'this is a file, not a directory');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── Pure resolver tests ─────────────────────────────────────

test('source-checkout: config under OPS_ROOM_ROOT resolves to OPS_ROOM_ROOT', () => {
  const l = createSourceCheckoutLayout();
  try {
    assert.equal(_resolveConfigRootForTest(l.root), l.root);
    assert.equal(existsSync(join(l.root, 'config', 'agent-profiles')), true);
  } finally { l.cleanup(); }
});

test('immutable-release: config under parent resolves to parent', () => {
  const l = createImmutableReleaseLayout();
  try {
    assert.equal(_resolveConfigRootForTest(l.root), join(l.root, '..'));
    assert.equal(existsSync(join(l.root, '..', 'config', 'agent-profiles')), true);
  } finally { l.cleanup(); }
});

test('regular file named "config" is NOT accepted', () => {
  const l = createFileNotDirLayout();
  try {
    assert.throws(() => _resolveConfigRootForTest(l.root), /Cannot locate config root/);
  } finally { l.cleanup(); }
});

test('missing config throws clear error listing paths and env vars', () => {
  const l = createNoConfigLayout();
  try {
    assert.throws(
      () => _resolveConfigRootForTest(l.root),
      (e: Error) =>
        e.message.includes(l.root) &&
        e.message.includes('Cannot locate config root') &&
        e.message.includes('OPS_ROOM_AGENT_PROFILES_DIR'),
    );
  } finally { l.cleanup(); }
});

test('only two bounded ancestor levels checked (config 4+ levels up not found)', () => {
  const deep = join(tmpdir(), `rpt-deep-${Date.now()}-${s()}`);
  const opsRoot = join(deep, 'a', 'b', 'c', 'ops-room');
  mkdirSync(opsRoot, { recursive: true });
  mkdirSync(join(deep, 'config', 'agent-profiles'), { recursive: true });
  try {
    // Candidate 1: opsRoot/config → no
    // Candidate 2: a/b/c/config → no
    // deep/config is at a/b/c/../../.. which is NOT checked
    assert.throws(() => _resolveConfigRootForTest(opsRoot), /Cannot locate config root/);
  } finally { rmSync(deep, { recursive: true, force: true }); }
});

// ── Environment override (child process, real module) ───────

function nodeScriptEval(script: string, env?: Record<string, string>, targetDir?: string): string {
  const dir = targetDir ?? cwd();
  const tmpScript = join(dir, `.rpt-eval-${Date.now()}-${s()}.mjs`);
  writeFileSync(tmpScript, script);
  try {
    return execFileSync(execPath, [tmpScript], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
    });
  } finally {
    rmSync(tmpScript, { force: true });
  }
}

test('env override takes precedence — resolves to custom dir, not layout', () => {
  const l = createImmutableReleaseLayout();
  const customDir = join(tmpdir(), `rpt-env-${Date.now()}-${s()}`);
  mkdirSync(customDir, { recursive: true });
  try {
    const out = nodeScriptEval(
      `import { AGENT_PROFILES_DIR } from './src/services/runtime-paths.js';
       console.log('DIR:' + AGENT_PROFILES_DIR);`,
      { OPS_ROOM_AGENT_PROFILES_DIR: customDir },
    );
    const match = out.match(/^DIR:(.+)$/m);
    assert.ok(match, `Expected DIR: in output:\n${out}`);
    assert.equal(match[1], customDir, 'Env override must take precedence');
  } finally {
    l.cleanup();
    rmSync(customDir, { recursive: true, force: true });
  }
});

test('without env override, real source-checkout layout resolves correctly', () => {
  // Running from the repo checkout — config/ exists under the package root.
  // Clear env overrides so the default layout resolver runs.
  const out = nodeScriptEval(
    `import { existsSync } from 'node:fs';
     import { AGENT_PROFILES_DIR, SKILL_MANIFESTS_DIR, MEMORY_SPACE_MANIFESTS_DIR } from './src/services/runtime-paths.js';
     for (const [k, v] of Object.entries({ PROFILES: AGENT_PROFILES_DIR, SKILLS: SKILL_MANIFESTS_DIR, MEMORY: MEMORY_SPACE_MANIFESTS_DIR })) {
       console.log(k + ':' + v + ':' + existsSync(v));
     }`,
    {
      OPS_ROOM_AGENT_PROFILES_DIR: '',
      OPS_ROOM_SKILL_MANIFESTS_DIR: '',
      OPS_ROOM_MEMORY_SPACE_MANIFESTS_DIR: '',
    },
  );
  for (const line of out.trim().split('\n')) {
    // lastIndexOf(':') gives the last colon before the exists value
    // indexOf(':') gives the one after the key name
    // Between them is the directory path (may contain D: on Windows)
    const lastColon = line.lastIndexOf(':');
    const firstColon = line.indexOf(':');
    const dir = line.slice(firstColon + 1, lastColon);
    const exists = line.slice(lastColon + 1);
    assert.equal(exists, 'true', `Expected ${dir} to exist:\n${line}`);
  }
});

// ── Real immutable artifact integration test ────────────────

test('immutable release artifact: config resolves from release root without overrides', async () => {
  const extracted = join(tmpdir(), `rpt-art-${Date.now()}-${s()}`);
  const buildDir = join(tmpdir(), `rpt-build-${Date.now()}-${s()}`);
  mkdirSync(extracted, { recursive: true });
  mkdirSync(buildDir, { recursive: true });
  try {
    // Build the release artifact from the current source.
    // Use npm from the executable directory (works on Unix and cross-platform CI).
    const nodeBin = execPath;
    const nodeDir = join(nodeBin, '..');
    const npmBin = resolve(join(nodeDir, 'npm' + (process.platform === 'win32' ? '.cmd' : '')));
    // Fallback: on Windows the npm.cmd may be parallel to node.exe, not in bin/
    const npmBinAlt = resolve(join(nodeDir, '..', 'npm' + (process.platform === 'win32' ? '.cmd' : '')));
    const npm = existsSync(npmBin) ? npmBin : (existsSync(npmBinAlt) ? npmBinAlt : 'npm');
    const spawnOptions: Record<string, unknown> = {
      cwd: cwd(),
      timeout: 120000,
      stdio: 'pipe',
    };
    if (process.platform === 'win32') spawnOptions.shell = true;
    execFileSync(npm, ['run', 'release:build', '--', '732bbc80bf3259b883b54b69c57fb5c45db75ed8', buildDir], spawnOptions);

    // Find the built artifact
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(buildDir);
    const artifact = entries.find((e: string) => e.endsWith('.tar.gz'));
    if (!artifact) throw new Error(`No tar.gz found in ${buildDir}: ${entries.join(', ')}`);
    const artifactPath = join(buildDir, artifact);

    // Extract the real release artifact
    execFileSync('tar', ['-xzf', artifactPath, '-C', extracted], { timeout: 30000 });

    // Confirm structure: config/ at release root, NOT inside ops-room/
    assert.equal(existsSync(join(extracted, 'config', 'agent-profiles')), true);
    assert.equal(existsSync(join(extracted, 'ops-room', 'src')), true);
    assert.equal(existsSync(join(extracted, 'ops-room', 'config')), false);

    // Run from <extracted>/ops-room so __dirname resolution
    // simulates the production runtime location.
    const out = nodeScriptEval(
      `import { AGENT_PROFILES_DIR, SKILL_MANIFESTS_DIR, MEMORY_SPACE_MANIFESTS_DIR } from './ops-room/src/services/runtime-paths.js';
       import { existsSync } from 'node:fs';
       console.log('PROFILES:' + AGENT_PROFILES_DIR + ':' + existsSync(AGENT_PROFILES_DIR));
       console.log('SKILLS:' + SKILL_MANIFESTS_DIR + ':' + existsSync(SKILL_MANIFESTS_DIR));
       console.log('MEMORY:' + MEMORY_SPACE_MANIFESTS_DIR + ':' + existsSync(MEMORY_SPACE_MANIFESTS_DIR));`,
      {},  // no env overrides — force layout resolution
      extracted,
    );

    const expectedProfiles = join(extracted, 'config', 'agent-profiles');
    const expectedDir = join(extracted, 'config');

    for (const line of out.trim().split('\n')) {
      // Use lastIndexOf(':') for Windows drive-letter compatibility
      const lastColon = line.lastIndexOf(':');
      const firstColon = line.indexOf(':');
      const key = line.slice(0, firstColon);
      const dir = line.slice(firstColon + 1, lastColon);
      const exists = line.slice(lastColon + 1);
      assert.equal(exists, 'true', `${dir} must exist at release root`);
      // Verify the directory is under <extracted>/config/, not <extracted>/ops-room/config/
      assert.ok(
        dir.startsWith(expectedDir),
        `${key} resolved to ${dir}, expected under ${expectedDir}`,
      );
      assert.ok(
        !dir.includes('/ops-room/config/'),
        `${key} must NOT resolve inside ops-room/`,
      );
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }
});
