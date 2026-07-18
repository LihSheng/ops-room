import { execSync, execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { AGENT_NAMES, BOT_USERS, LABEL_COLORS } from '../lib/config.js';
import { extractTask, isCodingTask, parseFlags } from '../lib/task-routing.js';
import {
  addComment, ghApi, ghApiText, ensureLabel, removeLabel, addLabel, transitionLabels, githubToken
} from '../services/github.js';
import {
  REPO, WORKSPACE_BASE, FORBIDDEN_FILE_PATTERNS, LOCK_DIR, PROMPT_DIR
} from '../services/runtime-paths.js';
import { runChatWorkflow } from './chat-response.js';
import { runPrReviewWorkflow } from './pr-review.js';
import { writeTaskLog } from '../services/logs.js';
import {
  loadProcessedTasks, markTaskProcessed, acquireLock, releaseLock, ensureDir, fileExists
} from '../services/task-store.js';
import { notify } from '../lib/notify.js';

const activeProcesses = new Map();

// ── Git credential helper ───────────────────────────────────────────────────

const ASKPASS_SCRIPT_NAME = platform() === 'win32' ? 'askpass.bat' : 'askpass.sh';

function buildAskpassScriptPath(ctx) {
  const dir = join(tmpdir(), 'openab-askpass', `issue-${ctx.issueNumber}-${ctx.agent}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, ASKPASS_SCRIPT_NAME);
}

function createAskpassHelper(ctx) {
  const token = githubToken(ctx.agent);
  const scriptPath = buildAskpassScriptPath(ctx);

  if (platform() === 'win32') {
    writeFileSync(scriptPath, `@echo off\r\necho username=x-access-token\r\necho password=%GIT_ASKPASS_TOKEN%\r\n`);
  } else {
    writeFileSync(scriptPath, `#!/bin/sh\necho "username=x-access-token"\necho "password=$GIT_ASKPASS_TOKEN"\n`, { mode: 0o500 });
  }

  return {
    scriptPath,
    env: {
      GIT_ASKPASS: scriptPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS_TOKEN: token,
    },
  };
}

function registerAgentProcess(ctx, child) {
  const lp = join('/tmp/openab-locks', `issue-${ctx.issueNumber}-${ctx.agent}.lock`);
  activeProcesses.set(lp, child);
  child.on('exit', () => activeProcesses.delete(lp));
}

function cleanupAskpassHelper(ctx) {
  if (!ctx._askpassScriptPath) return;
  try {
    rmSync(dirname(ctx._askpassScriptPath), { recursive: true, force: true });
  } catch {}
  ctx._askpassScriptPath = null;
}

async function cancelTask(issueNumber, agentKey) {
  const ctx = { issueNumber, agent: agentKey };
  const lp = join('/tmp/openab-locks', `issue-${issueNumber}-${agentKey}.lock`);
  const child = activeProcesses.get(lp);
  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
  }
  try {
    const { rm } = await import('node:fs/promises');
    await rm(lp, { force: true });
  } catch {}
  try {
    execSync(`gh issue edit ${issueNumber} --remove-label "openab/${agentKey}/wip" --remove-label "openab/cancel" --add-label "openab/cancelled" --repo "${REPO}"`, { encoding: 'utf-8' });
  } catch {}
  console.log(`[poller] Cancelled task #${issueNumber} for ${agentKey}`);
}

// ── Default branch detection ────────────────────────────────────────────────

function getDefaultBranch(env) {
  return execSync(
    `gh repo view ${REPO} --json defaultBranchRef --jq .defaultBranchRef.name`,
    { encoding: 'utf-8', env }
  ).trim() || 'main';
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

// ── Workspace ───────────────────────────────────────────────────────────────

async function prepareWorkspace(ctx) {
  const workspaceDir = ctx.workspaceDir;
  const parent = dirname(workspaceDir);

  await ensureDir(parent);
  if (!process.env.OPS_ROOM_KEEP_WORKSPACE) {
    await rm(workspaceDir, { recursive: true, force: true });
  }

  const token = githubToken(ctx.agent);
  const ghEnv = { ...process.env, GH_TOKEN: token };

  execFileSync('gh', ['repo', 'clone', REPO, workspaceDir], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: ghEnv,
  });

  const askpass = createAskpassHelper(ctx);
  const gitEnv = { ...process.env, ...askpass.env };
  ctx._askpassScriptPath = askpass.scriptPath;

  try {
    execFileSync('git', ['fetch', 'origin', '--prune'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: workspaceDir,
      env: gitEnv,
    });
  } finally {
    cleanupAskpassHelper(ctx);
  }

  const defaultBranch = getDefaultBranch(ghEnv);
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
    execFileSync('which', [cmd], { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function maskToken(text) {
  return text.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:REDACTED@');
}

async function execLogged(command, ctx, opts = {}) {
  const { allowFailure, env } = opts;
  const safeCommand = maskToken(command);
  const label = safeCommand.slice(0, 200);
  const execOpts = { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: 'pipe' };
  if (env) execOpts.env = env;
  try {
    const out = execSync(command, execOpts);
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

// Allowlisted vars for coding agent subprocesses.
// ponytail: explicit allowlist prevents credential leaks to agent CLIs.
// Deferred: per-provider scoping, per-agent profiles.
const AGENT_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
  'SHELL', 'LANG', 'LC_ALL', 'NODE_PATH', 'NODE_ENV', 'NODE_OPTIONS',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION',
  'OPENCODE_API_KEY', 'OPENCODE_MODEL', 'OPENCODE_MAX_TOKENS', 'OPENCODE_MAX_TOKEN',
  'NVIDIA_API_KEY', 'NVIDIA_MODEL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPS_ROOM_KEEP_WORKSPACE',
  'GH_TOKEN',
  'OPENAB_REPO',
]);

function buildAgentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (AGENT_ENV_ALLOWLIST.has(key) || AGENT_ENV_ALLOWLIST.has(key.toUpperCase())) {
      env[key.toUpperCase()] = value;
    }
  }
  return env;
}

function runCommandWithStdin({ command, args, cwd, stdin, env = process.env, timeoutMs, ctx }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (ctx) registerAgentProcess(ctx, child);

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
    env: buildAgentEnv(),
    timeoutMs: 30 * 60 * 1000,
    ctx,
  });
}

async function runCodexWithPrompt(ctx, promptContent) {
  await writeTaskLog(ctx, ['Invoking codex CLI via safe stdin runner']);
  return runCommandWithStdin({
    command: 'codex',
    args: ['exec', '-'],
    cwd: ctx.workspaceDir,
    stdin: promptContent,
    env: buildAgentEnv(),
    timeoutMs: 30 * 60 * 1000,
    ctx,
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
      env: buildAgentEnv(),
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
    const promptDir = PROMPT_DIR;
    await mkdir(promptDir, { recursive: true });
    const filePath = join(promptDir, `${ctx.taskId || 'unknown'}.md`);
    await writeFile(filePath, promptContent, 'utf-8');
    console.log(`[coding] prompt saved: ${filePath}`);
  } catch (e) {
    console.warn(`[coding] failed to save prompt for debug: ${e.message}`);
  }
}

// ── Git helpers ─────────────────────────────────────────────────────────────

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
    'next.config.mjs',
    'next.config.js',
    'eslint.config.mjs',
    'eslint.config.js',
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
    file.endsWith('.mjs') ||
    file.endsWith('.jsx') ||
    file.endsWith('.js') ||
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
  const askpass = createAskpassHelper(ctx);
  const gitEnv = { ...process.env, ...askpass.env };
  try {
    const result = await execLogged(
      `cd "${ctx.workspaceDir}" && git push origin HEAD:refs/heads/"${ctx.branchName}"`,
      ctx,
      { allowFailure: true, env: gitEnv }
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
  } finally {
    cleanupAskpassHelper(ctx);
  }
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

// ── Failure handler ─────────────────────────────────────────────────────────

async function handleCodingFailure(ctx, error) {
  const safeMessage = String(error?.message || error).slice(0, 4000);

  const isCommandFailure = safeMessage.includes('Coding command failed');
  const isNoChangeFailure = safeMessage.includes('no file changes') || safeMessage.includes('No changes');

  let failureType = 'coding task failed';
  if (isCommandFailure) failureType = 'coding command failed';
  else if (isNoChangeFailure) failureType = 'no source changes detected';

  const branchLine = ctx.branchName ? `- Branch: \`${ctx.branchName}\`\n` : '';

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

${branchLine}
Reason:

\`\`\`txt
${safeMessage}
\`\`\`

Labels updated to \`openab/${ctx.agent}/failed\`.

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

async function ensureLabels(ctx) {
  ensureLabel(`openab/${ctx.agent}/wip`, LABEL_COLORS.wip);
  ensureLabel(`openab/${ctx.agent}/failed`, LABEL_COLORS.failed);
  ensureLabel('openab/pr-created', LABEL_COLORS.pr);
  ensureLabel('openab/needs-human', LABEL_COLORS.needsHuman);
  ensureLabel('openab/done', LABEL_COLORS.done);
  ensureLabel('openab/review-pending', LABEL_COLORS.reviewPending);
  ensureLabel('openab/changes-requested', LABEL_COLORS.changesRequested);
  ensureLabel('openab/review-approved', LABEL_COLORS.reviewApproved);
  ensureLabel('openab/review-loop', LABEL_COLORS.reviewLoop);
  ensureLabel('openab/auto-fix-failed', LABEL_COLORS.autoFixFailed);
}

// ── Run coding workflow ─────────────────────────────────────────────────────

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

// ── Main task handler ───────────────────────────────────────────────────────

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
    const labelNames = issue.labels?.map((label) => label.name) || [];
    const isPrReviewTask = Boolean(
      issue.pull_request && (
        labelNames.includes('openab/pr-review') ||
        labelNames.includes(`openab/${agentKey}/review`)
      )
    );

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
      if (isPrReviewTask) {
        console.log(`[poller] Skipping legacy PR review producer for #${issueNumber}; use the controller webhook path`);
      } else if (isCoding) {
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

export {
  commandExists,
  prepareWorkspace,
  excludeHarnessFilesFromGit,
  writeTaskPrompt,
  runCodingWorkflow,
  runCodingAgent,
  collectGitDebugSnapshot,
  validateCodingWorkspace,
  execCapture,
  buildContext,
  handleTask,
  buildBranchName,
  cancelTask,
  registerAgentProcess,
  commitIfChanges,
  pushBranch,
  hasGitChanges,
  getChangedFiles,
  getGitDiffStat,
  configureGitAuthor,
  execLogged,
  createAskpassHelper,
  cleanupAskpassHelper,
  buildAskpassScriptPath,
  buildAgentEnv,
  maskToken,
};
