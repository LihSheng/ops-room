import { appendFile, open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { LOG_DIR, utcTimestamp } from './runtime-paths.mjs';

const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
console.log = (...args) => _origLog(`[${utcTimestamp()}]`, ...args);
console.error = (...args) => _origError(`[${utcTimestamp()}]`, ...args);
console.warn = (...args) => _origWarn(`[${utcTimestamp()}]`, ...args);

export function taskLogFile(ctx) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(LOG_DIR, `issue-${ctx.issueNumber}-${ctx.agent}-${ts}.log`);
}

export async function writeTaskLog(ctx, lines) {
  try {
    const path = taskLogFile(ctx);
    const content = lines.map(l => `[${new Date().toISOString()}] ${l}`).join('\n') + '\n';
    await appendFile(path, content);
  } catch { }
}

export function redactSecrets(text) {
  return String(text || '')
    .replaceAll('\u0000', '')
    .replace(/(x-access-token:)[^@\s]+/gi, '$1REDACTED')
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1REDACTED')
    .replace(/((?:token|secret|password|credential|private[_-]?key)\s*[=:]\s*)[^\s"']+/gi, '$1REDACTED')
    .replace(/ghp_[A-Za-z0-9_]+/g, 'REDACTED')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'REDACTED');
}

function clampLimit(rawLimit) {
  const parsed = Number.parseInt(rawLimit || '200', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(parsed, 1000);
}

function matchesFilter(fileName, { agent, taskId }) {
  if (agent && !fileName.includes(`-${agent}-`) && !fileName.includes(agent)) return false;
  if (taskId && !fileName.includes(taskId)) return false;
  return true;
}

async function readFileTail(path, maxBytes = 256 * 1024) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf-8');
  } finally {
    await handle.close();
  }
}

export async function readLogFiles({ agent = '', taskId = '', limit = 200 } = {}) {
  const boundedLimit = clampLimit(limit);
  let files = [];

  try {
    files = await readdir(LOG_DIR);
  } catch {
    return { logs: [], limit: boundedLimit };
  }

  const logFiles = files
    .filter((file) => file.endsWith('.log'))
    .filter((file) => matchesFilter(file, { agent, taskId }))
    .sort()
    .slice(-20);

  const logs = await Promise.all(logFiles.map(async (file) => {
    const raw = await readFileTail(join(LOG_DIR, file));
    const lines = redactSecrets(raw).split(/\r?\n/).filter(Boolean).slice(-boundedLimit);
    return {
      file: basename(file),
      lines,
    };
  }));

  return { logs, limit: boundedLimit };
}
