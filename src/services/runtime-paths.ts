import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OPS_ROOM_ROOT = join(__dirname, '..', '..');

/**
 * Resolve the default configuration directory.
 *
 * Returns the actual `config/` directory (not the repository root).
 * Two bounded layouts are supported:
 *
 * 1. Source-checkout layout (CI, dev, tests):
 *    <OPS_ROOM_ROOT>/config/   → returns <OPS_ROOM_ROOT>/config
 *
 * 2. Immutable production-release layout (deployed artifact):
 *    <release-root>/config/    → returns <release-root>/config
 *    <release-root>/ops-room/  ← this is OPS_ROOM_ROOT
 *
 * Exactly two locations are checked. Each candidate must be a directory
 * and contain agent-profiles (governed sentinel). No unbounded search.
 * Throws a clear error when neither location is valid.
 */
function resolveConfigRoot(root?: string): string {
  const base = root ?? OPS_ROOM_ROOT;
  for (const candidate of [join(base, 'config'), join(base, '..', 'config')]) {
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'agent-profiles'))) {
        return candidate;
      }
    } catch {
      // statSync or existsSync may throw ENOENT — skip to next candidate.
    }
  }
  throw new Error(
    `Cannot locate config directory: checked ${join(base, 'config')} and ${join(base, '..', 'config')}. ` +
    'Set OPS_ROOM_CONFIG_ROOT, or individual overrides: OPS_ROOM_AGENT_PROFILES_DIR, ' +
    'OPS_ROOM_SKILL_MANIFESTS_DIR, OPS_ROOM_MEMORY_SPACE_MANIFESTS_DIR, OPENAB_AGENTS_CONFIG_DIR.',
  );
}

const CONFIG_ROOT: string = process.env.OPS_ROOM_CONFIG_ROOT || resolveConfigRoot();

// Exported for testing — accepts an optional root override for layout simulation.
export { resolveConfigRoot as _resolveConfigRootForTest };
const _dataDir = process.env.OPENAB_DATA_DIR || join(OPS_ROOM_ROOT, 'data');
const _opsRoomDataDir = process.env.OPS_ROOM_DATA_DIR || join(_dataDir, 'ops-room');
const _requiredCommands = Object.hasOwn(process.env, 'OPS_ROOM_REQUIRED_COMMANDS')
  ? process.env.OPS_ROOM_REQUIRED_COMMANDS
  : 'git,gh';
const packageJson = createRequire(import.meta.url)('../../package.json');

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), minimum), maximum);
}

export const PORT = parseInt(process.env.OPENAB_WEBHOOK_PORT || '7381', 10);
export const HOST = process.env.OPENAB_WEBHOOK_HOST || '127.0.0.1';
export const WEBHOOK_SECRET = process.env.OPENAB_WEBHOOK_SECRET;
export const DASHBOARD_TOKEN = process.env.OPS_ROOM_DASHBOARD_TOKEN || WEBHOOK_SECRET || '';
export const OPERATOR_API_ENABLED = process.env.OPS_ROOM_OPERATOR_API_ENABLED === 'true';
export const OPERATOR_TOKEN = process.env.OPS_ROOM_OPERATOR_TOKEN || '';
export const OPERATOR_ID = process.env.OPS_ROOM_OPERATOR_ID || '';
export const OPERATOR_DISPLAY_NAME = process.env.OPS_ROOM_OPERATOR_DISPLAY_NAME || '';
export const HUMAN_AUTH_ENABLED = process.env.OPS_ROOM_HUMAN_AUTH_ENABLED === 'true';
export const EMERGENCY_READ_ONLY_ENABLED = process.env.OPS_ROOM_EMERGENCY_READ_ONLY_ENABLED === 'true';
export const OPERATOR_CONFIGURED_ROLES = Object.freeze(
  String(process.env.OPS_ROOM_OPERATOR_ROLES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
export const OPERATOR_SESSION_TTL_SECONDS = boundedInteger(
  process.env.OPS_ROOM_OPERATOR_SESSION_TTL_SECONDS,
  8 * 60 * 60,
  300,
  7 * 24 * 60 * 60,
);
export const OPERATOR_SESSION_COOKIE_SECURE = process.env.OPS_ROOM_OPERATOR_SESSION_COOKIE_SECURE !== 'false';
export const AGENT_LIFECYCLE_ENABLED = process.env.OPS_ROOM_AGENT_LIFECYCLE_ENABLED === 'true';
export const AGENT_LIFECYCLE_ALLOWED_AGENTS = Object.freeze(
  String(process.env.OPS_ROOM_AGENT_LIFECYCLE_ALLOWED_AGENTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
export const AGENT_LIFECYCLE_DRAIN_TIMEOUT_MS = boundedInteger(process.env.OPS_ROOM_AGENT_LIFECYCLE_DRAIN_TIMEOUT_MS, 20_000, 0, 300_000);
export const AGENT_LIFECYCLE_DRAIN_POLL_MS = boundedInteger(process.env.OPS_ROOM_AGENT_LIFECYCLE_DRAIN_POLL_MS, 500, 50, 5_000);
export const AGENT_LIFECYCLE_STOP_TIMEOUT_SECONDS = boundedInteger(process.env.OPS_ROOM_AGENT_LIFECYCLE_STOP_TIMEOUT_SECONDS, 20, 1, 120);
export const AGENT_LIFECYCLE_START_TIMEOUT_SECONDS = boundedInteger(process.env.OPS_ROOM_AGENT_LIFECYCLE_START_TIMEOUT_SECONDS, 30, 1, 120);
export const ISSUE_POLLING_ENABLED = process.env.OPS_ROOM_ISSUE_POLLING_ENABLED !== 'false';
export const REQUIRED_COMMANDS = _requiredCommands.split(',').map((value) => value.trim()).filter(Boolean);
export const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.OPS_ROOM_SHUTDOWN_TIMEOUT_MS || '55000', 10);
export const DATA_DIR = _dataDir;
export const OPS_ROOM_DATA_DIR = _opsRoomDataDir;
export const AGENTS_CONFIG_DIR = process.env.OPENAB_AGENTS_CONFIG_DIR || join(CONFIG_ROOT, 'agents');
export const AGENT_PROFILES_DIR = process.env.OPS_ROOM_AGENT_PROFILES_DIR || join(CONFIG_ROOT, 'agent-profiles');
export const SKILL_MANIFESTS_DIR = process.env.OPS_ROOM_SKILL_MANIFESTS_DIR || join(CONFIG_ROOT, 'skills');
export const MEMORY_SPACE_MANIFESTS_DIR = process.env.OPS_ROOM_MEMORY_SPACE_MANIFESTS_DIR || join(CONFIG_ROOT, 'memory-spaces');
export const TASKS_DIR = process.env.OPS_ROOM_TASKS_DIR || join(_opsRoomDataDir, 'tasks');
export const REVIEW_TASKS_DIR = process.env.OPS_ROOM_REVIEW_TASKS_DIR || join(_opsRoomDataDir, 'review-tasks');
export const MISSIONS_DIR = process.env.OPS_ROOM_MISSIONS_DIR || join(_opsRoomDataDir, 'missions');
export const WORKFLOW_RUNS_DIR = process.env.OPS_ROOM_WORKFLOW_RUNS_DIR || join(_opsRoomDataDir, 'workflow-runs');
export const WORKFLOW_EFFECTS_DIR = process.env.OPS_ROOM_WORKFLOW_EFFECTS_DIR || join(_opsRoomDataDir, 'workflow-effects');
export const AGENT_CHAT_SESSIONS_DIR = process.env.OPS_ROOM_AGENT_CHAT_SESSIONS_DIR || join(_opsRoomDataDir, 'agent-chat-sessions');
export const MISSION_CHAT_SESSIONS_DIR = process.env.OPS_ROOM_MISSION_CHAT_SESSIONS_DIR || join(_opsRoomDataDir, 'mission-chat-sessions');
export const LOG_DIR = process.env.OPS_ROOM_LOGS_DIR || join(_opsRoomDataDir, 'logs');
export const STATE_DIR = process.env.OPS_ROOM_STATE_DIR || join(_opsRoomDataDir, 'state');
export const AUDIT_DIR = process.env.OPS_ROOM_AUDIT_DIR || join(_opsRoomDataDir, 'audit');
export const IDEMPOTENCY_DIR = process.env.OPS_ROOM_IDEMPOTENCY_DIR || join(_opsRoomDataDir, 'idempotency');
export const LIFECYCLE_DIR = process.env.OPS_ROOM_LIFECYCLE_DIR || join(_opsRoomDataDir, 'lifecycle');
export const OPERATOR_SESSION_DIR = process.env.OPS_ROOM_OPERATOR_SESSIONS_DIR || join(_opsRoomDataDir, 'operator-sessions');
export const OPERATOR_NOTIFICATION_STATE_DIR = process.env.OPS_ROOM_OPERATOR_NOTIFICATION_STATE_DIR || join(_opsRoomDataDir, 'operator-notification-state');
export const WORKSPACE_BASE = process.env.OPENAB_WORKSPACES_DIR || process.env.OPENAB_WORKSPACE_BASE || join(_dataDir, 'workspaces');
export const REPOSITORY_CACHE_ROOT = process.env.OPS_ROOM_REPOSITORY_CACHE_ROOT || join(_dataDir, 'repositories');
export const TASK_WORKSPACE_ROOT = process.env.OPS_ROOM_TASK_WORKSPACE_ROOT || WORKSPACE_BASE;
export const WORKSPACE_RECORDS_DIR = process.env.OPS_ROOM_WORKSPACE_RECORDS_DIR || join(_opsRoomDataDir, 'workspaces');
export const WORKSPACE_LOCK_DIR = process.env.OPS_ROOM_WORKSPACE_LOCK_DIR || join(_opsRoomDataDir, 'workspace-locks');
export const WORKSPACE_MAX_ACTIVE = boundedInteger(process.env.OPS_ROOM_WORKSPACE_MAX_ACTIVE, 8, 1, 64);
export const WORKSPACE_MIN_FREE_BYTES = boundedInteger(process.env.OPS_ROOM_WORKSPACE_MIN_FREE_BYTES, 1024 * 1024 * 1024, 0, Number.MAX_SAFE_INTEGER);
export const SHARED_MEMORY = process.env.OPENAB_SHARED_DIR ? join(process.env.OPENAB_SHARED_DIR, 'memory.md') : join(_dataDir, 'shared', 'memory.md');
export const LOCK_DIR = '/tmp/openab-locks';
export const PROCESSED_TASKS_FILE = join(STATE_DIR, 'processed-tasks.json');
export const PROMPT_DIR = join(_dataDir, 'task-prompts');

export const OPENCODE_API = 'https://opencode.ai/zen/go/v1/chat/completions';
export const NVIDIA_API = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.1-70b-instruct';
export const OPENCODE_MODEL = process.env.OPENCODE_MODEL || 'deepseek-v4-flash';
export const OPENCODE_MAX_TOKEN = parseInt(process.env.OPENCODE_MAX_TOKEN || process.env.OPENCODE_MAX_TOKENS || '16384', 10);
export const REPO = process.env.OPENAB_REPO || 'LihSheng/LinkUp';

export const FORBIDDEN_FILE_PATTERNS = [/^\.env/, /^\.openab(\/|$)/, /private-key/i, /secret/i, /credential/i];

export const OPENAB_SERVER_VERSION = packageJson.version;

export function utcTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
}

export function compactUtcTimestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

export function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length);
}
