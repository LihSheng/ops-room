import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPS_ROOM_ROOT = join(__dirname, '..', '..');
const _dataDir = join(OPS_ROOM_ROOT, '..', 'data');

export const PORT = parseInt(process.env.OPENAB_WEBHOOK_PORT || '7381', 10);
export const WEBHOOK_SECRET = process.env.OPENAB_WEBHOOK_SECRET;
export const DATA_DIR = _dataDir;
export const TASKS_DIR = process.env.OPS_ROOM_TASKS_DIR || join(_dataDir, 'ops-room', 'tasks');
export const LOG_DIR = process.env.OPS_ROOM_LOGS_DIR || join(_dataDir, 'ops-room', 'logs');
export const STATE_DIR = process.env.OPS_ROOM_STATE_DIR || join(_dataDir, 'ops-room', 'state');
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

export const OPENAB_SERVER_VERSION = 'openab-harness-v3-2026-06-26';

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
