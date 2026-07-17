import { commandExists } from '../workflows/github-code.mjs';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  TASKS_DIR, STATE_DIR, LOG_DIR, WORKSPACE_BASE,
  OPENAB_SERVER_VERSION, OPS_ROOM_RELEASE_SHA
} from '../services/runtime-paths.mjs';
import { processLifecycle } from '../services/process-lifecycle.mjs';

let cachedCommandStatus = null;
let cachedAt = 0;
const COMMAND_CACHE_MS = 30_000;

async function getCommandStatus(commandExistsFn = commandExists) {
  if (commandExistsFn !== commandExists) {
    return {
      git: await commandExistsFn('git'),
      gh: await commandExistsFn('gh'),
      opencode: await commandExistsFn('opencode'),
      codex: await commandExistsFn('codex'),
      claude: await commandExistsFn('claude'),
    };
  }
  const now = Date.now();
  if (cachedCommandStatus && now - cachedAt < COMMAND_CACHE_MS) {
    return cachedCommandStatus;
  }

  cachedCommandStatus = {
    git: await commandExistsFn('git'),
    gh: await commandExistsFn('gh'),
    opencode: await commandExistsFn('opencode'),
    codex: await commandExistsFn('codex'),
    claude: await commandExistsFn('claude'),
  };
  cachedAt = now;
  return cachedCommandStatus;
}

async function checkDirectory(path) {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return { status: 'ok', required: true };
  } catch (error) {
    return { status: 'error', required: true, error: error?.code || 'unavailable' };
  }
}

export async function handleHealth({
  commandExistsFn = commandExists,
  directoryCheckFn = checkDirectory,
  lifecycle = processLifecycle,
} = {}) {
  const dependencyEntries = await Promise.all([
    ['task_store', directoryCheckFn(TASKS_DIR)],
    ['state_store', directoryCheckFn(STATE_DIR)],
    ['log_store', directoryCheckFn(LOG_DIR)],
    ['workspace_store', directoryCheckFn(WORKSPACE_BASE)],
  ].map(async ([name, result]) => [name, await result]));
  const dependencies = Object.fromEntries(dependencyEntries);
  const criticalReady = Object.values(dependencies).every((dependency) => dependency.status === 'ok');
  const lifecycleStatus = lifecycle.getStatus();
  const ready = criticalReady && lifecycleStatus.state === 'running';

  return {
    status: ready ? 'ok' : lifecycleStatus.state === 'draining' ? 'draining' : 'degraded',
    ready,
    uptime_seconds: Math.floor(process.uptime()),
    version: OPENAB_SERVER_VERSION,
    revision: OPS_ROOM_RELEASE_SHA,
    lifecycle: lifecycleStatus,
    dependencies,
    paths: {
      tasks_dir: TASKS_DIR,
      state_dir: STATE_DIR,
      logs_dir: LOG_DIR,
      workspaces_dir: WORKSPACE_BASE,
    },
    commands: await getCommandStatus(commandExistsFn),
  };
}
