import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OPS_ROOM_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(OPS_ROOM_ROOT, '..');
const _dataDir = process.env.OPENAB_DATA_DIR || join(REPO_ROOT, 'data');
const _opsRoomDataDir = process.env.OPS_ROOM_DATA_DIR || join(_dataDir, 'ops-room');
const _requiredCommands = Object.hasOwn(process.env, 'OPS_ROOM_REQUIRED_COMMANDS')
  ? process.env.OPS_ROOM_REQUIRED_COMMANDS
  : 'git,gh';
const packageJson = createRequire(import.meta.url)('../../package.json');

export const PORT = parseInt(process.env.OPENAB_WEBHOOK_PORT || '7381', 10);
export const HOST = process.env.OPENAB_WEBHOOK_HOST || '127.0.0.1';
export const WEBHOOK_SECRET = process.env.OPENAB_WEBHOOK_SECRET;
export const DASHBOARD_TOKEN = process.env.OPS_ROOM_DASHBOARD_TOKEN || WEBHOOK_SECRET || '';
export const OPERATOR_API_ENABLED = process.env.OPS_ROOM_OPERATOR_API_ENABLED === 'true';
export const OPERATOR_TOKEN = process.env.OPS_ROOM_OPERATOR_TOKEN || '';
export const OPERATOR_ID = process.env.OPS_ROOM_OPERATOR_ID || '';
export const OPERATOR_DISPLAY_NAME = process.env.OPS_ROOM_OPERATOR_DISPLAY_NAME || '';
export const ISSUE_POLLING_ENABLED = process.env.OPS_ROOM_ISSUE_POLLING_ENABLED !== 'false';
export const REQUIRED_COMMANDS = _requiredCommands.split(',').map((value) => value.trim()).filter(Boolean);
export const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.OPS_ROOM_SHUTDOWN_TIMEOUT_MS || '55000', 10);
export const DATA_DIR = _dataDir;
export const OPS_ROOM_DATA_DIR = _opsRoomDataDir;
export const AGENTS_CONFIG_DIR = process.env.OPENAB_AGENTS_CONFIG_DIR || join(REPO_ROOT, 'config', 'agents');
export const AGENT_PROFILES_DIR = process.env.OPS_ROOM_AGENT_PROFILES_DIR || join(REPO_ROOT, 'config', 'agent-profiles');
export const SKILL_MANIFESTS_DIR = process.env.OPS_ROOM_SKILL_MANIFESTS_DIR || join(REPO_ROOT, 'config', 'skills');
export const MEMORY_SPACE_MANIFESTS_DIR = process.env.OPS_ROOM_MEMORY_SPACE_MANIFESTS_DIR || join(REPO_ROOT, 'config', 'memory-spaces');
export const TASKS_DIR = process.env.OPS_ROOM_TASKS_DIR || join(_opsRoomDataDir, 'tasks');
export const REVIEW_TASKS_DIR = process.env.OPS_ROOM_REVIEW_TASKS_DIR || join(_opsRoomDataDir, 'review-tasks');
export const LOG_DIR = process.env.OPS_ROOM_LOGS_DIR || join(_opsRoomDataDir, 'logs');
export const STATE_DIR = process.env.OPS_ROOM_STATE_DIR || join(_opsRoomDataDir, 'state');
export const AUDIT_DIR = process.env.OPS_ROOM_AUDIT_DIR || join(_opsRoomDataDir, 'audit');
export const IDEMPOTENCY_DIR = process.env.OPS_ROOM_IDEMPOTENCY_DIR || join(_opsRoomDataDir, 'idempotency');
export const WORKSPACE_BASE = process.env.OPENAB_WORKSPACES_DIR || process.env.OPENAB_WORKSPACE_BASE || join(_dataDir, 'workspaces');
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

export const FORBIDDEN_FILE_PATTERNS = [
  /^\.env/,
  /^\.openab(\/|$)/,
  /private-key/i,
  /secret/i,
  /credential/i,
];

export const OPENAB_SERVER_VERSION = packageJson.version;

export function utcTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
}

export function compactUtcTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14);
}

export function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length);
}
