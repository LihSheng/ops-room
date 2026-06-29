import { commandExists } from '../workflows/github-code.mjs';
import {
  TASKS_DIR, STATE_DIR, LOG_DIR, WORKSPACE_BASE,
  OPENAB_SERVER_VERSION
} from '../services/runtime-paths.mjs';

let cachedCommandStatus = null;
let cachedAt = 0;
const COMMAND_CACHE_MS = 30_000;

async function getCommandStatus() {
  const now = Date.now();
  if (cachedCommandStatus && now - cachedAt < COMMAND_CACHE_MS) {
    return cachedCommandStatus;
  }

  cachedCommandStatus = {
    git: await commandExists('git'),
    gh: await commandExists('gh'),
    opencode: await commandExists('opencode'),
    codex: await commandExists('codex'),
    claude: await commandExists('claude'),
  };
  cachedAt = now;
  return cachedCommandStatus;
}

export async function handleHealth() {
  return {
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    version: OPENAB_SERVER_VERSION,
    paths: {
      tasks_dir: TASKS_DIR,
      state_dir: STATE_DIR,
      logs_dir: LOG_DIR,
      workspaces_dir: WORKSPACE_BASE,
    },
    commands: await getCommandStatus(),
  };
}
