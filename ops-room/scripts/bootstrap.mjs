#!/usr/bin/env node
import { mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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

const requiredVars = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_WEBHOOK_SECRET',
  'OPENCODE_API_KEY',
];

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

async function main() {
  console.log('Ops Room Bootstrap\n');

  console.log('Creating runtime directories...');
  for (const dir of requiredDirs) {
    await ensureDir(dir);
  }

  console.log('\nChecking required environment variables...');
  let missing = 0;
  for (const v of requiredVars) {
    if (process.env[v]) {
      console.log(`  ✓ ${v} is set`);
    } else {
      console.log(`  ✗ ${v} is NOT set`);
      missing++;
    }
  }

  if (missing > 0) {
    console.log(`\n⚠ ${missing} required env var(s) missing.`);
    console.log('  The server will start but webhook auth and GitHub API calls may fail.');
    console.log('  Copy .env.example → .env and fill in the values.');
  }

  console.log('\nChecking .env file...');
  const envPath = join(REPO_ROOT, '.env');
  if (await fileExists(envPath)) {
    console.log('  ✓ .env exists');
  } else {
    console.log('  ✗ .env not found — copy .env.example → .env');
  }

  console.log('\nBootstrap complete.');
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
