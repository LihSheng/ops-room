#!/usr/bin/env node
import { mkdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPS_ROOM_ROOT = join(__dirname, '..');
const REPO_ROOT = join(OPS_ROOM_ROOT, '..');

const requiredDirs = [
  join(REPO_ROOT, 'data', 'agents'),
  join(REPO_ROOT, 'data', 'workspaces'),
  join(REPO_ROOT, 'data', 'shared'),
  join(REPO_ROOT, 'data', 'ops-room', 'logs'),
  join(REPO_ROOT, 'data', 'ops-room', 'state'),
  join(REPO_ROOT, 'data', 'ops-room', 'tasks'),
  join(REPO_ROOT, 'secrets'),
];

export const REPO_ENV_PATH = join(REPO_ROOT, '.env');
export const STARTUP_REQUIRED_VARS = ['OPENAB_WEBHOOK_SECRET'];

async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true });
    const rel = dir.replace(REPO_ROOT, '.').replace(/^\//, '');
    console.log(`  ✓ ${rel}`);
  } catch (err) {
    if (err.code !== 'EEXIST') console.error(`  ✗ ${dir}: ${err.message}`);
  }
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function loadBootstrapEnvironment(envPath = REPO_ENV_PATH) {
  if (!await fileExists(envPath)) return false;
  loadEnvFile(envPath);
  return true;
}

export function missingStartupVars(env = process.env) {
  return STARTUP_REQUIRED_VARS.filter((name) => !env[name]);
}

export async function main({
  envPath = REPO_ENV_PATH,
  env = process.env,
  createDirectories = true,
  output = console,
} = {}) {
  output.log('Ops Room Bootstrap\n');

  output.log('Loading repo environment...');
  if (await loadBootstrapEnvironment(envPath)) {
    output.log('  ✓ .env exists and was loaded');
  } else {
    output.log('  ✗ .env not found — copy .env.example → .env');
  }

  if (createDirectories) {
    output.log('Creating runtime directories...');
    for (const dir of requiredDirs) {
      await ensureDir(dir);
    }
  }

  output.log('\nChecking startup-required environment variables...');
  const missing = missingStartupVars(env);
  for (const name of STARTUP_REQUIRED_VARS) {
    output.log(`  ${missing.includes(name) ? '✗' : '✓'} ${name} is ${missing.includes(name) ? 'NOT set' : 'set'}`);
  }

  if (missing.length > 0) {
    output.error(`\nStartup blocked: ${missing.join(', ')} must be set.`);
    output.error('  Ops Room refuses to start without an explicit webhook bearer secret.');
    output.log('  Copy .env.example → .env and fill in the values.');
    return 1;
  }

  output.log('\nBootstrap complete. Ops Room startup requirements are satisfied.');
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((err) => {
      console.error('Bootstrap failed:', err);
      process.exitCode = 1;
    });
}
