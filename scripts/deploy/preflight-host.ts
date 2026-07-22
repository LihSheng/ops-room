import { access, lstat, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MINIMUM_NODE_VERSION = [20, 19, 0];
const ABSOLUTE_PATH_KEYS = new Set([
  'GITHUB_APP_KEY_PATH',
  'GITHUB_APP_KEY_PATH_BERLIN',
  'GITHUB_APP_KEY_PATH_TOKYO',
  'OPENAB_AGENT_KNOWLEDGE_DIR',
  'OPENAB_AGENTS_CONFIG_DIR',
  'OPENAB_AGENTS_DIR',
  'OPENAB_CONFIG_DIR',
  'OPENAB_DATA_DIR',
  'OPENAB_ROOT',
  'OPENAB_SECRETS_DIR',
  'OPENAB_SHARED_DIR',
  'OPENAB_WORKSPACES_DIR',
  'OPS_ROOM_DATA_DIR',
  'OPS_ROOM_AUDIT_DIR',
  'OPS_ROOM_IDEMPOTENCY_DIR',
  'OPS_ROOM_LOGS_DIR',
  'OPS_ROOM_REVIEW_TASKS_DIR',
  'OPS_ROOM_ROOT',
  'OPS_ROOM_STATE_DIR',
  'OPS_ROOM_TASKS_DIR',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function versionTuple(value: string) {
  return value.trim().split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual: string, minimum = MINIMUM_NODE_VERSION) {
  const tuple = versionTuple(actual);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((tuple[index] || 0) > minimum[index]) return true;
    if ((tuple[index] || 0) < minimum[index]) return false;
  }
  return true;
}

function parseEnvFile(content: string) {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    values.set(key, value);
  }
  return values;
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultCommand(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: 'utf-8', timeout: 10_000 });
}

export async function runPreflight({
  installRoot = process.env.OPS_ROOM_INSTALL_ROOT || '/opt/ops-room',
  envFile = process.env.OPS_ROOM_ENV_FILE || '/etc/openab/ops-room.env',
  serviceFile = process.env.OPS_ROOM_SYSTEMD_UNIT || '/etc/systemd/system/openab-ops-room.service',
  nodeBin = process.env.OPS_ROOM_NODE_BIN || join(installRoot, 'bin', 'node'),
  scriptsDir = process.env.OPS_ROOM_DEPLOY_SCRIPTS_DIR || join(installRoot, 'scripts'),
  requireRootOwnership = process.env.OPS_ROOM_PREFLIGHT_REQUIRE_ROOT_OWNERSHIP !== 'false',
  runCommand = defaultCommand,
} = {}) {
  const checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = [];
  const record = (name: string, status: 'pass' | 'warn' | 'fail', detail: string) => {
    checks.push({ name, status, detail });
  };

  const inspectPath = async (
    name: string,
    path: string,
    { executable = false, directory = false, rootOwned = requireRootOwnership } = {},
  ) => {
    try {
      const info = await stat(path);
      if (directory && !info.isDirectory()) {
        record(name, 'fail', `${path} is not a directory`);
        return null;
      }
      if (!directory && !info.isFile()) {
        record(name, 'fail', `${path} is not a regular file`);
        return null;
      }
      if (executable && (info.mode & 0o111) === 0) {
        record(name, 'fail', `${path} is not executable`);
        return null;
      }
      if (rootOwned && info.uid !== 0) {
        record(name, 'fail', `${path} must be owned by root (uid 0), found uid ${info.uid}`);
        return null;
      }
      if (rootOwned && (info.mode & 0o022) !== 0) {
        record(name, 'fail', `${path} must not be group/other writable`);
        return null;
      }
      record(name, 'pass', path);
      return info;
    } catch (error) {
      record(name, 'fail', `${path}: ${error?.code || error?.message || 'unavailable'}`);
      return null;
    }
  };

  if (!isAbsolute(installRoot) || installRoot === '/') {
    record('install root', 'fail', `unsafe install root: ${installRoot}`);
  } else {
    record('install root', 'pass', installRoot);
  }

  await inspectPath('release directory', join(installRoot, 'releases'), { directory: true });
  await inspectPath('deployment lock directory', join(installRoot, 'locks'), { directory: true });
  await inspectPath('stable Node binding', nodeBin, { executable: true });
  await inspectPath('activation script', join(scriptsDir, 'activate-release.sh'), { executable: true });
  await inspectPath('rollback script', join(scriptsDir, 'rollback-release.sh'), { executable: true });
  await inspectPath('release verifier', join(scriptsDir, 'verify-release.js'), { executable: false });

  if (await exists(nodeBin)) {
    const result = runCommand(nodeBin, ['-p', 'process.versions.node']);
    const version = String(result.stdout || '').trim();
    if (result.status !== 0 || !version) {
      record('Node version', 'fail', String(result.stderr || 'unable to read Node version').trim());
    } else if (!versionAtLeast(version)) {
      record('Node version', 'fail', `Node ${version}; require 20.19.0 or newer`);
    } else {
      record('Node version', 'pass', version);
    }
  }

  const envInfo = await inspectPath('environment file', envFile, { rootOwned: requireRootOwnership });
  if (envInfo) {
    if ((envInfo.mode & 0o007) !== 0) {
      record('environment file permissions', 'fail', `${envFile} must not grant access to other users`);
    } else {
      record('environment file permissions', 'pass', `${(envInfo.mode & 0o777).toString(8)}`);
    }

    const values = parseEnvFile(await readFile(envFile, 'utf-8'));
    const relativeKeys = [...ABSOLUTE_PATH_KEYS]
      .filter((key) => values.has(key) && values.get(key) && !isAbsolute(values.get(key)!));
    if (relativeKeys.length > 0) {
      record('persistent path configuration', 'fail', `relative path values: ${relativeKeys.join(', ')}`);
    } else {
      record('persistent path configuration', 'pass', 'configured path values are absolute');
    }

    if (!values.get('OPENAB_WEBHOOK_SECRET')) {
      record('webhook credential reference', 'fail', 'OPENAB_WEBHOOK_SECRET is empty');
    } else {
      record('webhook credential reference', 'pass', 'configured (value not displayed)');
    }

    const bindHost = values.get('OPENAB_WEBHOOK_HOST') || '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(bindHost)) {
      record('network bind boundary', 'fail', `OPENAB_WEBHOOK_HOST must be loopback, found ${bindHost}`);
    } else {
      record('network bind boundary', 'pass', bindHost);
    }

    if (values.get('OPS_ROOM_OPERATOR_API_ENABLED') === 'true') {
      record('operator API safety', 'fail', 'operator mutations must remain disabled during the deployment drill');
    } else {
      record('operator API safety', 'pass', 'disabled');
    }
  }

  const serviceInfo = await inspectPath('systemd unit', serviceFile, { rootOwned: requireRootOwnership });
  if (serviceInfo) {
    const service = await readFile(serviceFile, 'utf-8');
    const expectedWorkingDirectory = `WorkingDirectory=${join(installRoot, 'current', 'ops-room')}`;
    const expectedNode = `ExecStart=${nodeBin} src/server/webhook.js`;
    const expectedEnv = `EnvironmentFile=${envFile}`;
    const missing = [expectedWorkingDirectory, expectedNode, expectedEnv].filter((line) => !service.includes(line));
    if (missing.length > 0) {
      record('systemd release contract', 'fail', `missing: ${missing.join(' | ')}`);
    } else {
      record('systemd release contract', 'pass', 'immutable current symlink and stable Node binding configured');
    }
  }

  const currentLink = join(installRoot, 'current');
  try {
    const info = await lstat(currentLink);
    if (!info.isSymbolicLink()) {
      record('current release link', 'fail', `${currentLink} is not a symbolic link`);
    } else if (!(await exists(currentLink))) {
      record('current release link', 'fail', `${currentLink} is a broken symbolic link`);
    } else {
      record('current release link', 'pass', currentLink);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      record('current release link', 'warn', 'not present yet; expected before the first activation only');
    } else {
      record('current release link', 'fail', error?.message || 'cannot inspect current link');
    }
  }

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    checks,
    summary: {
      passed: checks.filter((check) => check.status === 'pass').length,
      warnings: checks.filter((check) => check.status === 'warn').length,
      failed: checks.filter((check) => check.status === 'fail').length,
    },
  };
}

function render(result) {
  for (const check of result.checks) {
    const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${marker}] ${check.name}: ${check.detail}`);
  }
  console.log(`\nPreflight: ${result.summary.passed} passed, ${result.summary.warnings} warning(s), ${result.summary.failed} failed`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const result = await runPreflight();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else render(result);
  if (!result.ok) process.exitCode = 1;
}
