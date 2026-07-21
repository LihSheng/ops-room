import { commandExists } from '../workflows/github-code.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  TASKS_DIR, REVIEW_TASKS_DIR, WORKFLOW_RUNS_DIR, WORKFLOW_EFFECTS_DIR, STATE_DIR, LOG_DIR, WORKSPACE_BASE, AUDIT_DIR, IDEMPOTENCY_DIR,
  LIFECYCLE_DIR, AGENT_PROFILES_DIR, MEMORY_SPACE_MANIFESTS_DIR, OPENAB_SERVER_VERSION, REQUIRED_COMMANDS,
} from '../services/runtime-paths.js';
import { processLifecycle } from '../services/process-lifecycle.js';
import { readReleaseInfo } from '../services/release-info.js';
import { getAgentProfileRegistryStatus } from '../services/agent-profile/registry.js';
import { getSkillRegistryStatus } from '../services/skill-registry/registry.js';
import { getMemorySpaceRegistryStatus } from '../services/memory-space-registry/registry.js';

let cachedCommandStatus = null;
let cachedAt = 0;
const COMMAND_CACHE_MS = 30_000;
const REPORTED_COMMANDS = ['git', 'gh', 'opencode', 'codex', 'claude'];

async function getCommandStatus(commandExistsFn = commandExists, requiredCommands = REQUIRED_COMMANDS) {
  const commandNames = [...new Set([...REPORTED_COMMANDS, ...requiredCommands])];
  if (commandExistsFn !== commandExists) {
    return Object.fromEntries(await Promise.all(
      commandNames.map(async (name) => [name, await commandExistsFn(name)]),
    ));
  }
  const now = Date.now();
  if (cachedCommandStatus && now - cachedAt < COMMAND_CACHE_MS) {
    return cachedCommandStatus;
  }

  cachedCommandStatus = Object.fromEntries(await Promise.all(
    commandNames.map(async (name) => [name, await commandExistsFn(name)]),
  ));
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

function dependencyReady(dependency) {
  return dependency.status === 'ok' || dependency.status === 'ready';
}

export async function handleHealth({
  commandExistsFn = commandExists,
  directoryCheckFn = checkDirectory,
  lifecycle = processLifecycle,
  releaseInfoFn = readReleaseInfo,
  profileStatusFn = getAgentProfileRegistryStatus,
  skillStatusFn = getSkillRegistryStatus,
  memoryStatusFn = getMemorySpaceRegistryStatus,
  requiredCommands = REQUIRED_COMMANDS,
} = {}) {
  let releaseInfo;
  let releaseIdentity;
  try {
    releaseInfo = await releaseInfoFn();
    releaseIdentity = { status: 'ok', required: true, source: releaseInfo.source };
  } catch (error) {
    releaseInfo = { commit_sha: 'unknown', source: 'invalid' };
    releaseIdentity = { status: 'error', required: true, error: error?.message || 'invalid release manifest' };
  }

  const profileRegistry = profileStatusFn();
  const skillRegistry = skillStatusFn();
  const memoryRegistry = memoryStatusFn();
  const commands = await getCommandStatus(commandExistsFn, requiredCommands);
  const dependencyEntries = await Promise.all([
    ['task_store', directoryCheckFn(TASKS_DIR)],
    ['review_task_store', directoryCheckFn(REVIEW_TASKS_DIR)],
    ['workflow_store', directoryCheckFn(WORKFLOW_RUNS_DIR)],
    ['workflow_effect_store', directoryCheckFn(WORKFLOW_EFFECTS_DIR)],
    ['state_store', directoryCheckFn(STATE_DIR)],
    ['log_store', directoryCheckFn(LOG_DIR)],
    ['audit_store', directoryCheckFn(AUDIT_DIR)],
    ['idempotency_store', directoryCheckFn(IDEMPOTENCY_DIR)],
    ['lifecycle_store', directoryCheckFn(LIFECYCLE_DIR)],
    ['workspace_store', directoryCheckFn(WORKSPACE_BASE)],
    ['agent_profiles', profileRegistry],
    ['skill_registry', skillRegistry],
    ['memory_registry', memoryRegistry],
    ['release_identity', releaseIdentity],
    ...requiredCommands.map((command) => [
      `command_${command}`,
      { status: commands[command] ? 'ok' : 'error', required: true, error: commands[command] ? undefined : 'unavailable' },
    ]),
  ].map(async ([name, result]) => [name, await result]));
  const dependencies = Object.fromEntries(dependencyEntries);
  const criticalReady = Object.values(dependencies).every(dependencyReady);
  const lifecycleStatus = lifecycle.getStatus();
  const ready = criticalReady && lifecycleStatus.state === 'running';

  return {
    status: ready ? 'ok' : lifecycleStatus.state === 'draining' ? 'draining' : 'degraded',
    ready,
    uptime_seconds: Math.floor(process.uptime()),
    version: OPENAB_SERVER_VERSION,
    revision: releaseInfo.commit_sha,
    release: releaseInfo,
    lifecycle: lifecycleStatus,
    profiles: profileRegistry,
    skill_registry: skillRegistry,
    memory_registry: memoryRegistry,
    dependencies,
    paths: {
      tasks_dir: TASKS_DIR,
      workflow_runs_dir: WORKFLOW_RUNS_DIR,
      workflow_effects_dir: WORKFLOW_EFFECTS_DIR,
      state_dir: STATE_DIR,
      logs_dir: LOG_DIR,
      audit_dir: AUDIT_DIR,
      idempotency_dir: IDEMPOTENCY_DIR,
      lifecycle_dir: LIFECYCLE_DIR,
      agent_profiles_dir: AGENT_PROFILES_DIR,
      memory_space_manifests_dir: MEMORY_SPACE_MANIFESTS_DIR,
      workspaces_dir: WORKSPACE_BASE,
    },
    commands,
  };
}
