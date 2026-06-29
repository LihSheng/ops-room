import { createServer } from 'node:http';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, appendFile, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS, AGENT_NAMES, BOT_USERS, LABEL_COLORS, POLL_AGENTS, normalizeAgent } from '../lib/config.mjs';
import { extractTask, isCodingTask, parseFlags } from '../lib/task-routing.mjs';
import { getTokenForAgent } from '../lib/github-app.mjs';
import { createGitHubOps } from '../lib/github-ops.mjs';
import { pollAgentIssues, startIssuePoller } from '../lib/issue-poller.mjs';
import { buildPrReviewPrompt } from './pr-review-payload.mjs';
import { notify } from '../lib/notify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function utcTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
}

const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
console.log = (...args) => _origLog(`[${utcTimestamp()}]`, ...args);
console.error = (...args) => _origError(`[${utcTimestamp()}]`, ...args);
console.warn = (...args) => _origWarn(`[${utcTimestamp()}]`, ...args);
const PORT = parseInt(process.env.OPENAB_WEBHOOK_PORT || '7381', 10);
const WEBHOOK_SECRET = process.env.OPENAB_WEBHOOK_SECRET;
const TASKS_DIR = process.env.OPS_ROOM_TASKS_DIR || join(__dirname, '..', '..', '..', 'data', 'ops-room', 'tasks');
const SHARED_MEMORY = process.env.OPENAB_SHARED_DIR ? join(process.env.OPENAB_SHARED_DIR, 'memory.md') : join(__dirname, '..', '..', '..', 'data', 'shared', 'memory.md');
const OPENCODE_API = 'https://opencode.ai/zen/go/v1/chat/completions';
const NVIDIA_API = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.1-70b-instruct';
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || 'deepseek-v4-flash';
const OPENCODE_MAX_TOKEN = parseInt(process.env.OPENCODE_MAX_TOKEN || '4096', 10);
const REPO = process.env.OPENAB_REPO || 'LihSheng/LinkUp';
const WORKSPACE_BASE = process.env.OPENAB_WORKSPACES_DIR || process.env.OPENAB_WORKSPACE_BASE || join(__dirname, '..', '..', '..', 'data', 'workspaces');
const LOG_DIR = process.env.OPS_ROOM_LOGS_DIR || join(__dirname, '..', '..', '..', 'data', 'ops-room', 'logs');
const STATE_DIR = process.env.OPS_ROOM_STATE_DIR || join(__dirname, '..', '..', '..', 'data', 'ops-room', 'state');
const LOCK_DIR = '/tmp/openab-locks';
const PROCESSED_TASKS_FILE = join(STATE_DIR, 'processed-tasks.json');
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');

const FORBIDDEN_FILE_PATTERNS = [
  /^\.env/,
  /^\.openab(\/|$)/,
  /private-key/i,
  /secret/i,
  /credential/i,
];

const OPENAB_SERVER_VERSION = 'openab-harness-v3-2026-06-26';

// ── Init ────────────────────────────────────────────────────────────────────

async function ensureDir(dir) {
  try { await mkdir(dir, { recursive: true }); } catch { }
}

async function fileExists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

async function initDirs() {
  await ensureDir(TASKS_DIR);
  await ensureDir(WORKSPACE_BASE);
  await ensureDir(LOG_DIR);
  await ensureDir(STATE_DIR);
  await ensureDir(LOCK_DIR);
  await ensureDir(join(DATA_DIR, 'task-prompts'));
}

// ── Auth ────────────────────────────────────────────────────────────────────

function verifyAuth(authHeader) {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match && match[1] === WEBHOOK_SECRET;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

async function appendToMemory(entry) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
    await appendFile(SHARED_MEMORY, `- ${ts}: [GitHub Issue] ${entry}\n`);
  } catch { }
}

// ── GitHub auth ─────────────────────────────────────────────────────────────

function githubToken(agentKey) {
  return getTokenForAgent(agentKey, join(__dirname, 'github-app-token.mjs'));
}
const {
  addComment,
  addPullRequestReview,
  ghApi,
  ghApiText,
  ensureLabel,
  removeLabel,
  addLabel,
  transitionLabels,
} = createGitHubOps({
  repo: REPO,
  tokenForAgent: githubToken,
  processEnv: process.env,
  logger: console,
});

// ── Processed task tracking ─────────────────────────────────────────────────

const PROCESSED_TASKS_LOG = PROCESSED_TASKS_FILE.replace('.json', '.log');

async function loadProcessedTasks() {
  try {
    const text = await readFile(PROCESSED_TASKS_LOG, 'utf-8');
    const ids = text.trim().split('\n').filter(Boolean);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

async function markTaskProcessed(taskId) {
  try {
    await appendFile(PROCESSED_TASKS_LOG, taskId + '\n');
  } catch {}
}

async function compactProcessedTasks() {
  try {
    const ids = await loadProcessedTasks();
    await writeFile(PROCESSED_TASKS_LOG, ids.join('\n') + '\n');
  } catch {}
}

// ── Lock file ───────────────────────────────────────────────────────────────

function lockPath(ctx) {
  return join(LOCK_DIR, `issue-${ctx.issueNumber}-${ctx.agent}.lock`);
}

function acquireLock(ctx) {
  try {
    writeFileSync(lockPath(ctx), String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(ctx) {
  try { await rm(lockPath(ctx), { force: true }); } catch { }
}

// ── Per-task logging ────────────────────────────────────────────────────────

function taskLogFile(ctx) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(LOG_DIR, `issue-${ctx.issueNumber}-${ctx.agent}-${ts}.log`);
}

async function writeTaskLog(ctx, lines) {
  try {
    const path = taskLogFile(ctx);
    const content = lines.map(l => `[${new Date().toISOString()}] ${l}`).join('\n') + '\n';
    await appendFile(path, content);
  } catch { }
}

// ── Branch name ─────────────────────────────────────────────────────────────

function compactUtcTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14);
}

function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length);
}

function buildBranchName(issueNumber, title, agent = 'agent') {
  const slug = String(title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || 'task';

  const safeAgent = String(agent || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';

  return `agent/${safeAgent}/issue-${issueNumber}-${slug}-${compactUtcTimestamp()}-${randomSuffix()}`;
}

// ── Authenticated remote URL ────────────────────────────────────────────────

function authedGitUrlForAgent(agent) {
  const token = githubToken(agent);
  return `https://x-access-token:${token}@github.com/${REPO}.git`;
}

// ── Default branch detection ────────────────────────────────────────────────

function getDefaultBranch(env) {
  return execSync(
    `gh repo view ${REPO} --json defaultBranchRef --jq .defaultBranchRef.name`,
    { encoding: 'utf-8', env }
  ).trim() || 'main';
}

// ── Workspace ───────────────────────────────────────────────────────────────

async function prepareWorkspace(ctx) {
  const workspaceDir = ctx.workspaceDir;
  const parent = dirname(workspaceDir);

  await ensureDir(parent);
  await rm(workspaceDir, { recursive: true, force: true });

  const token = githubToken(ctx.agent);
  const env = { ...process.env, GH_TOKEN: token };

  execFileSync('gh', ['repo', 'clone', REPO, workspaceDir], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
  });

  execFileSync('git', ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${REPO}.git`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: workspaceDir,
  });

  execFileSync('git', ['fetch', 'origin', '--prune'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: workspaceDir,
  });

  const defaultBranch = getDefaultBranch(env);
  ctx.defaultBranch = defaultBranch;

  execFileSync('git', ['checkout', defaultBranch], {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: workspaceDir,
  });

  execFileSync('git', ['reset', '--hard', `origin/${defaultBranch}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: workspaceDir,
  });

  execFileSync('git', ['checkout', '-b', ctx.branchName], {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: workspaceDir,
  });

  await writeTaskLog(ctx, [
    `Workspace prepared at ${workspaceDir}`,
    `Branch: ${ctx.branchName}`,
  ]);
}

// ── Exclude harness files from Git ──────────────────────────────────────────

async function excludeHarnessFilesFromGit(ctx) {
  const excludePath = join(ctx.workspaceDir, '.git', 'info', 'exclude');
  const rules = [
    '',
    '# OpenAB harness scratch files',
    '.openab/',
    '.openab/**',
  ].join('\n');

  await appendFile(excludePath, rules + '\n');
  await writeTaskLog(ctx, ['Added .openab/ to .git/info/exclude']);
}

// ── Task prompt file ────────────────────────────────────────────────────────

async function writeTaskPrompt(ctx) {
  const promptDir = join(ctx.workspaceDir, '.openab');
  await ensureDir(promptDir);

  const comments = ctx.comments && ctx.comments.length > 0
    ? ctx.comments
    : await ghApi('GET', `repos/${REPO}/issues/${ctx.issueNumber}/comments`);
  const commentsText = (Array.isArray(comments) ? comments : [])
    .map(c => `- @${c.user?.login || 'unknown'}: ${(c.body || '').slice(0, 500)}`)
    .join('\n');

  const content = `# OpenAB Coding Task

## Repository
${REPO}

## Issue
#${ctx.issueNumber} - ${ctx.issueTitle}

## User Command
${ctx.task}

## Issue Body
${ctx.issueBody || '(empty)'}

## Relevant Comments
${commentsText || '(none)'}

## Required Workflow
1. Read the issue carefully.
2. Inspect the existing code before editing.
3. Create the smallest useful implementation.
4. Do not rewrite unrelated files.
5. Do not modify secrets, \`.env\`, deployment config, or lock files unless required.
6. Run available checks.
7. Leave the repo in a committable state.
8. Do not create, switch, delete, push, or merge Git branches. The harness owns Git operations.
9. Do not write scratch/output files into the repository root.
10. Do not modify or commit files under \`.openab/\`.

## PR Requirements
The final PR must include:
- Summary
- Files changed
- Tests run
- Risks / review notes
- \`Closes #${ctx.issueNumber}\`

## Hard Rules
- Do not merge.
- Do not mark the task done yourself.
- If the issue is too large, implement the smallest coherent slice and explain what remains.
- Use the branch already prepared by the harness.
- Do not run \`git push\`, \`git merge\`, \`git rebase\`, or \`git reset --hard\`.
- Do not force push.
- Do not create root-level temporary files.
- Only commit-worthy source, test, documentation, or config changes should remain.
`;

  await writeFile(join(promptDir, 'TASK.md'), content);
  await writeTaskLog(ctx, ['Task prompt written to .openab/TASK.md']);
}

// ── Coding CLI ──────────────────────────────────────────────────────────────

async function commandExists(cmd) {
  try {
    execSync(`which "${cmd}"`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function maskToken(text) {
  return text.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:REDACTED@');
}

async function execLogged(command, ctx, opts = {}) {
  const { allowFailure } = opts;
  const safeCommand = maskToken(command);
  const label = safeCommand.slice(0, 200);
  try {
    const out = execSync(command, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: 'pipe' });
    await writeTaskLog(ctx, [`RUN: ${label}`, `EXIT: 0`, `OUT: ${maskToken(out).slice(0, 2000)}`]);
    return { ok: true, stdout: out };
  } catch (e) {
    const msg = maskToken(e.stderr?.toString()?.slice(0, 2000) || e.message);
    const code = e.status ?? -1;
    await writeTaskLog(ctx, [`RUN: ${label}`, `EXIT: ${code}`, `ERR: ${msg}`]);
    if (allowFailure) return { ok: false, stdout: '', error: msg };
    throw new Error(`Command failed (exit ${code}): ${msg}`);
  }
}

// ── Safe subprocess runner ────────────────────────────────────────────────────

function runCommandWithStdin({ command, args, cwd, stdin, env = process.env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
        }, timeoutMs)
      : null;

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal: signal || null, stdout, stderr });
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

async function runOpencodeWithPrompt(ctx, promptContent) {
  await writeTaskLog(ctx, ['Invoking opencode CLI via safe stdin runner']);
  return runCommandWithStdin({
    command: 'opencode',
    args: ['run', '-'],
    cwd: ctx.workspaceDir,
    stdin: promptContent,
    env: process.env,
    timeoutMs: 30 * 60 * 1000,
  });
}

async function runCodexWithPrompt(ctx, promptContent) {
  await writeTaskLog(ctx, ['Invoking codex CLI via safe stdin runner']);
  return runCommandWithStdin({
    command: 'codex',
    args: ['exec', '-'],
    cwd: ctx.workspaceDir,
    stdin: promptContent,
    env: process.env,
    timeoutMs: 30 * 60 * 1000,
  });
}

async function runCodingAgent(ctx) {
  const promptPath = join(ctx.workspaceDir, '.openab', 'TASK.md');
  const promptContent = await readFile(promptPath, 'utf-8');
  const codingTimeout = ctx.codingTimeoutMs || 30 * 60 * 1000;

  const backend = await commandExists('opencode') ? 'opencode'
    : await commandExists('codex') ? 'codex'
    : await commandExists('claude') ? 'claude'
    : null;

  if (!backend) {
    throw new Error("No coding CLI found. Expected one of: opencode, codex, claude.");
  }

  await saveTaskPromptForDebug(ctx, promptContent);

  console.log(`[coding] backend: ${backend}`);
  console.log(`[coding] cwd: ${ctx.workspaceDir}`);

  let result;
  if (backend === 'opencode') {
    result = await runOpencodeWithPrompt(ctx, promptContent);
  } else if (backend === 'codex') {
    result = await runCodexWithPrompt(ctx, promptContent);
  } else {
    result = await runCommandWithStdin({
      command: 'claude',
      args: ['-p', '-'],
      cwd: ctx.workspaceDir,
      stdin: promptContent,
      env: process.env,
      timeoutMs: codingTimeout,
    });
  }

  ctx.agentResult = result;

  const stdoutTail = (result.stdout || '').slice(-4000);
  const stderrTail = (result.stderr || '').slice(-4000);

  await writeTaskLog(ctx, [
    `Coding backend: ${backend}`,
    `Exit code: ${result.code}`,
    `Signal: ${result.signal || 'none'}`,
    `stdout (tail): ${stdoutTail || '(empty)'}`,
    `stderr (tail): ${stderrTail || '(empty)'}`,
  ]);

  console.log(`[coding] exit code: ${result.code}`);
  console.log(`[coding] signal: ${result.signal || 'none'}`);

  if (result.stdout) {
    console.log(`[coding] stdout tail: ${stdoutTail}`);
  }
  if (result.stderr) {
    console.log(`[coding] stderr tail: ${stderrTail}`);
  }

  if (result.code !== 0) {
    const lines = [
      `Coding command failed.`,
      `Backend: ${backend}`,
      `Exit code: ${result.code}`,
      `Workspace: ${ctx.workspaceDir}`,
      `stderr:`,
      stderrTail || '(empty)',
      `stdout:`,
      stdoutTail || '(empty)',
    ];
    throw new Error(lines.join('\n'));
  }
}

// ── Debug snapshot ────────────────────────────────────────────────────────────

async function collectGitDebugSnapshot(cwd) {
  const commands = [
    ['pwd', 'pwd'],
    ['gitTopLevel', 'git rev-parse --show-toplevel'],
    ['gitRemote', 'git remote -v'],
    ['gitBranch', 'git branch --show-current'],
    ['gitStatus', 'git status --porcelain'],
    ['gitDiffStat', 'git diff --stat'],
    ['recentFiles', 'find . -maxdepth 3 -type f -mmin -30 | sort 2>/dev/null || true'],
  ];

  const snapshot = {};
  for (const [key, cmd] of commands) {
    try {
      const out = execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
      snapshot[key] = { ok: true, stdout: out.slice(-4000) };
    } catch (e) {
      snapshot[key] = { ok: false, error: (e.stderr || '').slice(-1000) || e.message };
    }
  }
  return snapshot;
}

// ── Workspace validation ──────────────────────────────────────────────────────

async function validateCodingWorkspace(ctx) {
  const topLevel = execCapture('git rev-parse --show-toplevel', null, ctx.workspaceDir);
  if (!topLevel) {
    throw new Error(`Invalid coding workspace: not a git repo. Path: ${ctx.workspaceDir}`);
  }
  const remote = execCapture('git remote -v', null, ctx.workspaceDir);
  if (!remote.includes(ctx.repo || REPO)) {
    throw new Error(`Invalid coding workspace: remote does not point to expected repo "${ctx.repo || REPO}". Remote: ${remote.slice(0, 500)}`);
  }
  const branch = execCapture('git branch --show-current', null, ctx.workspaceDir);
  if (!branch) {
    throw new Error(`Invalid coding workspace: no current branch. Path: ${ctx.workspaceDir}`);
  }
  console.log(`[coding] workspace validated: ${topLevel} branch: ${branch}`);
}

// ── Save prompt for debug ─────────────────────────────────────────────────────

async function saveTaskPromptForDebug(ctx, promptContent) {
  try {
    const promptDir = join(DATA_DIR, 'task-prompts');
    await mkdir(promptDir, { recursive: true });
    const filePath = join(promptDir, `${ctx.taskId || 'unknown'}.md`);
    await writeFile(filePath, promptContent, 'utf-8');
    console.log(`[coding] prompt saved: ${filePath}`);
  } catch (e) {
    console.warn(`[coding] failed to save prompt for debug: ${e.message}`);
  }
}

// ── Git helpers ─────────────────────────────────────────────────────────────

function execCapture(command, env = null, cwd = null) {
  try {
    const opts = { encoding: 'utf-8', stdio: 'pipe' };
    if (env) opts.env = { ...process.env, ...env };
    if (cwd) opts.cwd = cwd;
    return execSync(command, opts).trim();
  } catch {
    return '';
  }
}

async function hasGitChanges(ctx) {
  const output = execCapture(`cd "${ctx.workspaceDir}" && git status --short`);
  return output.trim().length > 0;
}

function getChangedFiles(ctx) {
  const output = execCapture(`cd "${ctx.workspaceDir}" && git status --porcelain`);
  if (!output) return [];

  return output
    .split('\n')
    .map(line => line.slice(3).trim())
    .filter(Boolean)
    .map(file => file.replace(/^"|"$/g, ''));
}

function isForbiddenFile(path) {
  return FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

function isSuspiciousRootArtifact(path) {
  if (!path || path.includes('/')) return false;

  const allowedRootFiles = new Set([
    'README.md',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig.json',
    'next.config.js',
    'next.config.mjs',
    'eslint.config.js',
    'eslint.config.mjs',
    'vitest.config.ts',
    'jest.config.js',
    'playwright.config.ts',
    'prisma.schema',
  ]);

  if (allowedRootFiles.has(path)) return false;

  if (!path.includes('.')) return true;

  return false;
}

function validateChangedFiles(ctx, changedFiles) {
  const forbidden = changedFiles.filter(isForbiddenFile);
  if (forbidden.length > 0) {
    throw new Error(`Forbidden files modified: ${forbidden.join(', ')}`);
  }

  const suspicious = changedFiles.filter(isSuspiciousRootArtifact);
  if (suspicious.length > 0) {
    throw new Error(
      `Suspicious root-level artifact files detected: ${suspicious.join(', ')}. ` +
      `The agent likely wrote scratch/output files into the repo. Refusing to commit.`
    );
  }

  const realSourceOrTestChanges = changedFiles.filter((file) =>
    file.startsWith('src/') ||
    file.startsWith('app/') ||
    file.startsWith('components/') ||
    file.startsWith('lib/') ||
    file.startsWith('prisma/') ||
    file.startsWith('tests/') ||
    file.startsWith('__tests__/') ||
    file.endsWith('.ts') ||
    file.endsWith('.tsx') ||
    file.endsWith('.js') ||
    file.endsWith('.jsx') ||
    file.endsWith('.mjs') ||
    file.endsWith('.cjs')
  );

  if (realSourceOrTestChanges.length === 0) {
    throw new Error(
      `No real source/test changes detected. Changed files: ${changedFiles.join(', ')}`
    );
  }
}

function getGitDiffStat(ctx) {
  return execCapture(`cd "${ctx.workspaceDir}" && git diff --stat`);
}

// ── Checks ──────────────────────────────────────────────────────────────────

async function runChecks(ctx) {
  ctx.checkResults = [];
  const pkgPath = join(ctx.workspaceDir, 'package.json');
  const pkgExists = await fileExists(pkgPath);

  if (!pkgExists) {
    ctx.checkResults.push({ name: 'lint', status: 'skipped', reason: 'No package.json' });
    ctx.checkResults.push({ name: 'build', status: 'skipped', reason: 'No package.json' });
    ctx.checkResults.push({ name: 'test', status: 'skipped', reason: 'No package.json' });
    await writeTaskLog(ctx, ['No package.json found. Skipped JS checks.']);
    return;
  }

  const pkgRaw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(pkgRaw);
  const scripts = pkg.scripts || {};

  if (scripts.lint) {
    const result = await execLogged(`cd "${ctx.workspaceDir}" && npm run lint`, ctx, { allowFailure: true });
    ctx.checkResults.push({ name: 'lint', status: result.ok ? 'pass' : 'fail' });
  } else {
    ctx.checkResults.push({ name: 'lint', status: 'skipped', reason: 'No lint script' });
  }

  if (scripts.build) {
    const result = await execLogged(`cd "${ctx.workspaceDir}" && npm run build`, ctx, { allowFailure: true });
    ctx.checkResults.push({ name: 'build', status: result.ok ? 'pass' : 'fail' });
  } else {
    ctx.checkResults.push({ name: 'build', status: 'skipped', reason: 'No build script' });
  }

  if (scripts.test) {
    const result = await execLogged(`cd "${ctx.workspaceDir}" && npm test`, ctx, { allowFailure: true });
    ctx.checkResults.push({ name: 'test', status: result.ok ? 'pass' : 'fail' });
  } else {
    ctx.checkResults.push({ name: 'test', status: 'skipped', reason: 'No test script' });
  }
}

function checksSummary(ctx) {
  return (ctx.checkResults || []).map(c => {
    const status = c.status === 'pass' ? '✅ pass' : c.status === 'fail' ? '❌ fail' : `⏭️ skip`;
    const reason = c.reason ? ` (${c.reason})` : '';
    return `- \`${c.name}\`: ${status}${reason}`;
  }).join('\n');
}

// ── Commit ──────────────────────────────────────────────────────────────────

function configureGitAuthor(ctx) {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) {
    throw new Error('Missing workspaceDir when configuring Git author');
  }

  const agent = ctx.agent;
  const botUser = BOT_USERS[agent] || `lihsheng-${agent}[bot]`;
  execFileSync('git', ['config', 'user.name', botUser], { cwd: workspaceDir, encoding: 'utf-8' });
  execFileSync('git', ['config', 'user.email', `${botUser}@users.noreply.github.com`], { cwd: workspaceDir, encoding: 'utf-8' });
}

async function commitIfChanges(ctx) {
  if (!(await hasGitChanges(ctx))) {
    throw new Error("No changes to commit.");
  }

  const changedFiles = getChangedFiles(ctx);
  validateChangedFiles(ctx, changedFiles);

  configureGitAuthor(ctx);

  const shortTitle = ctx.issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  await execLogged(`cd "${ctx.workspaceDir}" && git add .`, ctx);
  await execLogged(`cd "${ctx.workspaceDir}" && git commit -m "Fix #${ctx.issueNumber}: ${shortTitle}"`, ctx);

  await writeTaskLog(ctx, [`Committed ${changedFiles.length} files`]);
}

// ── Push ────────────────────────────────────────────────────────────────────

async function pushBranch(ctx) {
  const result = await execLogged(
    `cd "${ctx.workspaceDir}" && git push origin HEAD:refs/heads/"${ctx.branchName}"`,
    ctx,
    { allowFailure: true }
  );

  if (!result.ok) {
    const error = result.error || '';

    if (
      error.includes('non-fast-forward') ||
      error.includes('fetch first') ||
      error.includes('Updates were rejected')
    ) {
      throw new Error(
        `Push rejected because remote branch already exists or local branch is stale. ` +
        `Harness must use a fresh unique branch. Branch: ${ctx.branchName}. ` +
        `Do not force push automatically.`
      );
    }

    throw new Error(`Push failed`);
  }

  await writeTaskLog(ctx, [`Branch pushed: ${ctx.branchName}`]);
}

// ── PR ──────────────────────────────────────────────────────────────────────

function buildPrBody(ctx) {
  const checks = checksSummary(ctx);
  const diffStat = ctx.diffStat || getGitDiffStat(ctx);

  return `Closes #${ctx.issueNumber}

## Summary
- Implements task: ${ctx.task}

## Files Changed
\`\`\`
${diffStat || '(no diff stat available)'}
\`\`\`

## Tests
${checks || '- No checks run'}

## Notes for Reviewer
- PR created automatically by OpenAB / ${AGENT_NAMES[ctx.agent] || ctx.agent}
- Branch: \`${ctx.branchName}\`

## Remaining Work
- Review and merge by human
`;
}

async function createPullRequest(ctx) {
  const token = githubToken(ctx.agent);
  const env = { ...process.env, GH_TOKEN: token };

  const defaultBranch = ctx.defaultBranch || getDefaultBranch(env);

  const title = `Fix #${ctx.issueNumber}: ${ctx.issueTitle}`;
  const body = buildPrBody(ctx);

  const args = [
    'pr', 'create',
    '--repo', REPO,
    '--base', defaultBranch,
    '--head', ctx.branchName,
    '--title', title,
    '--body', body,
  ];

  const out = execFileSync('gh', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    env,
  });

  const prUrl = out.trim();
  await writeTaskLog(ctx, [`PR created: ${prUrl}`]);
  return prUrl;
}

async function verifyPrExists(ctx) {
  const token = githubToken(ctx.agent);
  const env = { ...process.env, GH_TOKEN: token };
  const output = execCapture(
    `gh pr list --repo "${REPO}" --head "${ctx.branchName}" --json url --jq '.[0].url'`,
    env
  );
  return output.trim() || null;
}

// ── Chat workflow ───────────────────────────────────────────────────────────

async function askAI(prompt) {
  const tryProvider = async (apiUrl, apiKey, model) => {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: OPENCODE_MAX_TOKEN,
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  };

  if (process.env.OPENCODE_API_KEY) {
    try {
      return await tryProvider(OPENCODE_API, process.env.OPENCODE_API_KEY, OPENCODE_MODEL);
    } catch (e) {
      const msg = e.message || '';
      if (!msg.includes('401') && !msg.includes('Insufficient balance') && !msg.includes('402')) throw e;
      console.warn(`[poller] OpenCode API error: ${msg}`);
      console.warn(`[poller] OpenCode API failed, falling back to NVIDIA`);
    }
  }

  if (process.env.NVIDIA_API_KEY) {
    return await tryProvider(NVIDIA_API, process.env.NVIDIA_API_KEY, NVIDIA_MODEL);
  }

  throw new Error('No API key available (OPENCODE_API_KEY or NVIDIA_API_KEY)');
}

async function runChatWorkflow(ctx) {
  const agentName = AGENT_NAMES[ctx.agent] || ctx.agent;
  const context = `
Issue #${ctx.issueNumber} by @${ctx.issue.user?.login}
Title: ${ctx.issueTitle}
Body: ${(ctx.issueBody || '(empty)').slice(0, 1000)}

The user @${ctx.requester} gave this command to the ${agentName} agent on the issue: "${ctx.task}"

Answer concisely based on the issue details above. If you need more context, explain what information is missing.`.trim();

  const answer = await askAI(context);
  if (!answer) return;

  addComment(ctx.issueNumber, `**${agentName}** — response 🤖\n\n${answer}\n\n---\n*Auto-responded by OpenAB poller*`, ctx.agent);

  notify('chat.completed', { issue: ctx.issueNumber, title: ctx.issueTitle, agent: ctx.agent });

  await transitionLabels(ctx, {
    remove: [`openab/${ctx.agent}/wip`, `openab/${ctx.agent}`],
    add: ['openab/done'],
  });

  await writeTaskLog(ctx, [`Chat workflow complete for #${ctx.issueNumber}`]);
  console.log(`[poller] Chat response posted to #${ctx.issueNumber} for ${ctx.agent}`);
}

function parseReviewEvent(reviewText) {
  const upper = String(reviewText || '').toUpperCase();
  if (upper.includes('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (upper.includes('APPROVE')) return 'APPROVE';
  return 'COMMENT';
}

async function fetchPrReviewContext({ repository, pr, agent }) {
  const prData = ghApi('GET', `repos/${repository}/pulls/${pr}`, agent);
  const diff = ghApiText(
    'GET',
    `repos/${repository}/pulls/${pr}`,
    agent,
    ['Accept: application/vnd.github.v3.diff']
  );

  return {
    repository,
    pr,
    prTitle: prData.title || '',
    prBody: prData.body || '',
    prAuthor: prData.user?.login || 'unknown',
    baseRef: prData.base?.ref || '',
    headRef: prData.head?.ref || '',
    diff,
  };
}

async function runPrReviewWorkflow(payload) {
  const {
    agent,
    task,
    repository,
    pr,
    commenter = 'unknown',
  } = payload;

  const prContext = await fetchPrReviewContext({ repository, pr, agent });
  const prompt = buildPrReviewPrompt({
    agent: AGENT_NAMES[agent] || agent,
    task,
    repository,
    pr,
    ...prContext,
  });

  const reviewText = (await askAI(prompt)).trim();
  if (!reviewText) {
    throw new Error(`PR review generation returned an empty response for ${repository}#${pr}`);
  }

  const event = parseReviewEvent(reviewText);
  addPullRequestReview(pr, reviewText, event, agent);

  await appendToMemory(`PR review from ${repository}#${pr} by @${commenter} → **${agent}**: ${task}`);
  console.log(`[pr-review] Posted ${event} review on ${repository}#${pr} as ${agent}`);

  return {
    mode: 'pr_review',
    repository,
    pr,
    agent,
    review_event: event,
  };
}

// ── Coding workflow ─────────────────────────────────────────────────────────

async function handleCodingFailure(ctx, error) {
  const safeMessage = String(error?.message || error).slice(0, 4000);

  const isCommandFailure = safeMessage.includes('Coding command failed');
  const isNoChangeFailure = safeMessage.includes('no file changes') || safeMessage.includes('No changes');

  let failureType = 'coding task failed';
  if (isCommandFailure) failureType = 'coding command failed';
  else if (isNoChangeFailure) failureType = 'no source changes detected';

  const branchLine = ctx.branchName ? `- Branch: \`${ctx.branchName}\`\n` : '';
  const workspaceLine = ctx.workspaceDir ? `- Workspace: \`${ctx.workspaceDir}\`\n` : '';

  let extraHelp = '';
  if (isCommandFailure) {
    extraHelp = 'The coding backend did not complete successfully, so no PR was created.\n\nThis usually means the coding command failed before the agent could edit files.';
  } else if (isNoChangeFailure) {
    extraHelp = 'The coding backend exited successfully, but no source changes were detected.\n\nPossible causes:\n1. Agent did not edit files.\n2. Agent ran but decided no changes were needed.\n3. Agent edited outside the repo.\n4. Agent only created ignored files.';
  } else {
    extraHelp = 'An unexpected harness error occurred.';
  }

  await commentOnIssue(ctx, `**OpenAB / ${AGENT_NAMES[ctx.agent] || ctx.agent}** — ${failureType} ❌

Issue #${ctx.issueNumber}: ${ctx.issueTitle}

${extraHelp}

${workspaceLine}${branchLine}
Reason:

\`\`\`txt
${safeMessage}
\`\`\`

Labels updated to \`openab/${ctx.agent}/failed\`.

Please check server logs:

\`\`\`bash
tail -f data/ops-room/logs/server.log
\`\`\`

Suggested next action:
- Fix the underlying issue.
- Re-run with a new \`/openab <agent> --code\` comment.
- The retry will create a fresh branch automatically.`);

  await transitionLabels(ctx, {
    remove: [`openab/${ctx.agent}/wip`, `openab/${ctx.agent}`, 'openab/done'],
    add: [`openab/${ctx.agent}/failed`],
  });

  notify('task.failed', { issue: ctx.issueNumber, title: ctx.issueTitle, agent: ctx.agent, error: safeMessage });

  await writeTaskLog(ctx, [`FAILED (${failureType}): ${safeMessage}`]);
  console.error(`[poller] Coding task failed on #${ctx.issueNumber} (${failureType}):`, safeMessage.slice(0, 300));
}

function commentOnIssue(ctx, body) {
  addComment(ctx.issueNumber, body, ctx.agent);
}

async function runCodingWorkflow(ctx) {
  await ensureLabels(ctx);

  try {
    await commentOnIssue(ctx, `**OpenAB / ${AGENT_NAMES[ctx.agent] || ctx.agent}** — coding task started 🛠️

Issue #${ctx.issueNumber}: ${ctx.issueTitle}

I will create a branch, make changes, run checks, and open a PR. This task will not be marked done unless a PR URL exists.`);

    notify('task.started', { issue: ctx.issueNumber, title: ctx.issueTitle, agent: ctx.agent });

    await prepareWorkspace(ctx);
    await excludeHarnessFilesFromGit(ctx);
    await writeTaskPrompt(ctx);

    await validateCodingWorkspace(ctx);

    const beforeSnapshot = await collectGitDebugSnapshot(ctx.workspaceDir);
    console.log('[coding] before snapshot:', JSON.stringify(beforeSnapshot, null, 2));

    await runCodingAgent(ctx);

    const afterSnapshot = await collectGitDebugSnapshot(ctx.workspaceDir);
    console.log('[coding] after snapshot:', JSON.stringify(afterSnapshot, null, 2));

    await runChecks(ctx);

    const changedFiles = getChangedFiles(ctx);

    if (changedFiles.length === 0) {
      throw new Error("Coding agent completed but produced no file changes.");
    }

    const suspiciousFiles = changedFiles.filter(f =>
      f.startsWith('.openab/') || f === 'TASK.md' || f.endsWith('.task.md') || (/^[^/]+\.md$/.test(f) && f !== 'README.md')
    );
    if (suspiciousFiles.length > 0 && suspiciousFiles.length === changedFiles.length) {
      throw new Error(
        `Agent produced only task/markdown files and no real app/source changes. ` +
        `Files: ${suspiciousFiles.join(', ')}`
      );
    }

    validateChangedFiles(ctx, changedFiles);

    ctx.diffStat = getGitDiffStat(ctx);
    await commitIfChanges(ctx);
    await pushBranch(ctx);

    const prUrl = await createPullRequest(ctx);

    if (!prUrl) {
      throw new Error("PR creation failed: no PR URL returned");
    }

    const prUrlClean = prUrl.match(/https?:\/\/[^\s]+/)?.[0] || prUrl;

    await commentOnIssue(ctx, `**OpenAB / ${AGENT_NAMES[ctx.agent] || ctx.agent}** — PR created ✅

PR: ${prUrlClean}

Branch: \`${ctx.branchName}\`

This task is ready for human review.`);

    await transitionLabels(ctx, {
      remove: [`openab/${ctx.agent}/wip`, `openab/${ctx.agent}`, `openab/${ctx.agent}/failed`],
      add: ['openab/pr-created'],
    });

    notify('pr.created', { issue: ctx.issueNumber, title: ctx.issueTitle, agent: ctx.agent, prUrl: prUrlClean });

    await writeTaskLog(ctx, [
      `Coding workflow complete for #${ctx.issueNumber}`,
      `Branch: ${ctx.branchName}`,
      `PR: ${prUrlClean}`,
    ]);

    console.log(`[poller] Coding workflow complete on #${ctx.issueNumber}: ${prUrlClean}`);
    return { ok: true, prUrl: prUrlClean };
  } catch (error) {
    await handleCodingFailure(ctx, error);
    return { ok: false, error: error.message || String(error) };
  }
}

async function ensureLabels(ctx) {
  ensureLabel(`openab/${ctx.agent}/wip`, LABEL_COLORS.wip);
  ensureLabel(`openab/${ctx.agent}/failed`, LABEL_COLORS.failed);
  ensureLabel('openab/pr-created', LABEL_COLORS.pr);
  ensureLabel('openab/needs-human', LABEL_COLORS.needsHuman);
  ensureLabel('openab/done', LABEL_COLORS.done);
}

// ── Context builder ─────────────────────────────────────────────────────────

function buildContext(issue, comments, agentKey, task, commenter, taskId) {
  return {
    agent: agentKey,
    repo: REPO,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '',
    issue: issue,
    comments: Array.isArray(comments) ? comments : [],
    requester: commenter,
    task: task,
    taskId: taskId,
    repo: REPO,
    branchName: buildBranchName(issue.number, issue.title, agentKey),
    workspaceDir: join(WORKSPACE_BASE, `${REPO.replace('/', '-')}-issue-${issue.number}-${agentKey}`),
    startedAt: new Date().toISOString(),
    checkResults: [],
    diffStat: '',
  };
}

// ── Main response handler ───────────────────────────────────────────────────

async function handleTask(issueNumber, agentKey) {
  const taskId = `issue-${issueNumber}`;

  try {
    const issue = ghApi('GET', `repos/${REPO}/issues/${issueNumber}`);
    const rawComments = ghApi('GET', `repos/${REPO}/issues/${issueNumber}/comments`);
    const comments = Array.isArray(rawComments) ? rawComments : [];
    const task = extractTask(comments, agentKey);
    const taskDesc = task?.task || issue.title || '';
    const commenter = task?.commenter || issue.user?.login || 'someone';
    const extractedTaskId = task?.taskId || `${taskId}-${commenter}-${agentKey}`;
    const metadataTaskType = task?.taskType || null;

    const processed = await loadProcessedTasks();
    if (processed.includes(extractedTaskId)) {
      console.log(`[poller] Skipping already processed task ${extractedTaskId} on #${issueNumber}`);
      return;
    }

    const ctx = buildContext(issue, comments, agentKey, taskDesc, commenter, extractedTaskId);

    if (!acquireLock(ctx)) {
      console.log(`[poller] Lock held for #${issueNumber}/${agentKey}, skipping`);
      return;
    }

    try {
      const flag = parseFlags(taskDesc);

      let isCoding = false;
      if (flag === 'code') isCoding = true;
      else if (flag === 'chat') isCoding = false;
      else if (metadataTaskType === 'code') isCoding = true;
      else if (metadataTaskType === 'chat') isCoding = false;
      else isCoding = isCodingTask(taskDesc, issue);

      let codingResult;
      if (isCoding) {
        console.log(`[poller] Routing #${issueNumber} to CODING workflow (${agentKey})`);
        codingResult = await runCodingWorkflow(ctx);
      } else {
        console.log(`[poller] Routing #${issueNumber} to CHAT workflow (${agentKey})`);
        await runChatWorkflow(ctx);
      }

      if (codingResult && !codingResult.ok) {
        console.log(`[poller] Marking failed task as processed to avoid retry loop: ${extractedTaskId}`);
      } else {
        console.log(`[poller] Marking task as processed: ${extractedTaskId}`);
      }

      await markTaskProcessed(extractedTaskId);
    } finally {
      await releaseLock(ctx);
    }
  } catch (e) {
    const msg = e.stderr?.toString() || e.message;
    console.error(`[poller] handleTask error on #${issueNumber}:`, msg.slice(0, 300));
  }
}

// ── Webhook ─────────────────────────────────────────────────────────────────

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function isPrReviewWebhook(body) {
  return Boolean(
    body &&
    body.repository &&
    Number.isFinite(Number(body.pr))
  );
}

async function handleWebhook(body) {
  if (body.repository !== REPO) {
    throw new Error(`Unsupported repository: ${body.repository}. Expected ${REPO}`);
  }

  if (isPrReviewWebhook(body)) {
    const normalizedAgent = normalizeAgent(body.agent);
    if (!AGENT_IDS[normalizedAgent]) {
      throw new Error(`Unknown agent for PR review: ${body.agent}`);
    }

    return runPrReviewWorkflow({
      agent: normalizedAgent,
      task: body.task || 'Please review this pull request and respond based on the PR description, linked issue, and code changes.',
      repository: body.repository,
      pr: Number(body.pr),
      commenter: body.commenter || 'unknown',
    });
  }

  const { agent, task, repository, issue_number, issue_title, issue_url, commenter } = body;
  const normalizedAgent = normalizeAgent(agent);
  const agentId = AGENT_IDS[normalizedAgent];
  const agentName = agentId ? normalizedAgent : 'unassigned';
  const taskEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'github_issue', received_at: new Date().toISOString(),
    agent: agentName, task, repository, issue_number, issue_title, issue_url, commenter, status: 'pending',
    task_type: body.task_type || 'auto',
    trigger: body.trigger || 'manual',
    pr: body.pr ? Number(body.pr) : null,
  };
  await writeFile(join(TASKS_DIR, `${taskEntry.id}.json`), JSON.stringify(taskEntry, null, 2));
  await appendToMemory(`Task from ${repository}#${issue_number} by @${commenter} → **${agentName}**: ${task}`);
  return { id: taskEntry.id, agent: agentName };
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Powered-By', 'OpenAB Webhook');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') { sendJSON(res, 200, { status: 'ok', uptime: process.uptime() }); return; }
  if (req.method === 'GET' && req.url === '/tasks') {
    try {
      const files = await readdir(TASKS_DIR);
      const tasks = await Promise.all(files.filter(f => f.endsWith('.json')).map(f => readFile(join(TASKS_DIR, f), 'utf-8').then(JSON.parse)));
      sendJSON(res, 200, { tasks });
    } catch { sendJSON(res, 200, { tasks: [] }); }
    return;
  }
  if (req.method === 'POST' && req.url === '/webhook') {
    const auth = req.headers['authorization'];
    if (!verifyAuth(auth)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await parseBody(req);
      const hasIssuePayload = body.repository && body.issue_number;
      const hasPrPayload = isPrReviewWebhook(body);
      if (!hasIssuePayload && !hasPrPayload) {
        sendJSON(res, 400, { error: 'Missing required fields' });
        return;
      }
      const result = await handleWebhook(body);
      const targetNumber = body.issue_number || body.pr;
      console.log(`[openab] Received: ${body.repository}#${targetNumber} → ${result.agent}: ${body.task}`);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) { sendJSON(res, 400, { error: err.message }); }
    return;
  }
  sendJSON(res, 404, { error: 'Not found' });
});

// ── Poller ──────────────────────────────────────────────────────────────────

async function listOpenIssuesForAgent(agentKey) {
  try {
    const out = execSync(
      `gh api repos/${REPO}/issues?labels=${encodeURIComponent(`openab/${agentKey}`)}&state=open&per_page=100&sort=created&direction=desc`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    return JSON.parse(out).filter((issue) => !issue.pull_request || !issue.draft);
  } catch {
    return [];
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

console.log(`[server] version: ${OPENAB_SERVER_VERSION}`);

const diagnostics = {
  opencode: await commandExists('opencode'),
  codex: await commandExists('codex'),
  claude: await commandExists('claude'),
  gh: await commandExists('gh'),
  git: await commandExists('git'),
};
for (const [cmd, found] of Object.entries(diagnostics)) {
  console.log(`[server] command ${cmd}: ${found}`);
}

if (!WEBHOOK_SECRET) {
  throw new Error('Missing OPENAB_WEBHOOK_SECRET. Refusing to start webhook server without an explicit bearer secret.');
}

if (!diagnostics.opencode && !diagnostics.codex && !diagnostics.claude) {
  console.warn('[server] WARNING: No coding CLI found (opencode/codex/claude) — --code tasks will fail');
}

await initDirs();
startIssuePoller({
  agentKeys: POLL_AGENTS,
  intervalMs: 30_000,
  pollAgent: (agentKey) => pollAgentIssues({
    agentKey,
    listOpenIssuesForAgent,
    ensureLabel,
    removeLabel,
    addLabel,
    addComment,
    handleTask,
  }),
}).catch((e) => console.error('[server] poller fatal:', e.message));
server.listen(PORT, () => {
  console.log(`OpenAB webhook listening on http://0.0.0.0:${PORT}`);
  console.log(`  POST /webhook   - Receive issue commands`);
  console.log(`  GET  /tasks      - List pending tasks`);
  console.log(`  GET  /health     - Health check`);
  console.log(`  WORKSPACE_BASE   - ${WORKSPACE_BASE}`);
});
