import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { relative, resolve, sep, join } from 'node:path';

import { BOT_USERS } from '../lib/config.js';
import { FORBIDDEN_FILE_PATTERNS, WORKSPACE_BASE } from '../services/runtime-paths.js';
import { ghApi, ghApiText } from '../services/github.js';
import { askAI } from './chat-response.js';

const AGENT_CONTAINER = {
  berlin: 'openab-opencode-1',
  tokyo: 'openab-opencode-2',
  professor: 'openab-opencode-professor',
};

/** Legacy helper retained for compatibility only. OPS-009B task execution does not call it. */
export async function prepareFixWorkspace(repository, pr, fixAgent, headRef) {
  const dataDir = process.env.OPENAB_DATA_DIR || join(WORKSPACE_BASE, '..');
  const container = AGENT_CONTAINER[fixAgent];
  if (!container) throw new Error(`Unknown container for agent: ${fixAgent}`);

  const agentHomeName = fixAgent === 'berlin' ? 'opencode-1' : fixAgent === 'tokyo' ? 'opencode-2' : fixAgent;
  const hostWorkspace = join(dataDir, 'agents', agentHomeName, 'workspace', `pr-${pr}-fix`);
  const containerWorkspace = `/home/node/workspace/pr-${pr}-fix`;

  try { await rm(hostWorkspace, { recursive: true, force: true }); } catch {}
  await mkdir(hostWorkspace, { recursive: true });

  const enc = (cmd) => JSON.stringify(cmd);
  execSync(`docker exec ${container} rm -rf "${containerWorkspace}"`, { encoding: 'utf-8', timeout: 10_000 });
  execSync(`docker exec ${container} bash -c ${enc(`cd /home/node && gh repo clone ${repository} "${containerWorkspace}"`)}`, {
    encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
  });
  execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && git fetch origin --prune`)}`, {
    encoding: 'utf-8', timeout: 60_000,
  });
  const branch = headRef || `pr-${pr}`;
  execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && git checkout "${branch}"`)}`, {
    encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
  });
  return { hostWorkspace, containerWorkspace, container, branchName: branch, managed: false };
}

function runGit(workspace, args, timeout = 60_000) {
  try {
    return execFileSync('git', ['-C', workspace.hostWorkspace, ...args], {
      encoding: 'utf8', timeout, stdio: 'pipe', windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    throw new Error('managed_workspace_git_failed');
  }
}

function parseFiles(text) {
  return text.split(/### File:\s*/).slice(1).flatMap((block) => {
    const path = block.match(/^(.+?)(?:\n)/)?.[1]?.trim();
    const content = block.match(/```\w*\n([\s\S]*?)```/)?.[1];
    return path && content ? [{ path, content: content.trimEnd() }] : [];
  });
}

export function isSafeRelativePath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized && !normalized.startsWith('/') && !normalized.includes('..')
    && !normalized.split('/').includes('.git')
    && !FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function fixPrompt({ task, diff }) {
  return `You are fixing an existing pull request. Output ONLY complete replacement file blocks in this format:\n\n### File: relative/path\n\`\`\`language\ncomplete file contents\n\`\`\`\n\nDo not run git commands, create branches, push, modify secrets, or change unrelated files.\n\nStructured review findings:\n${JSON.stringify(task.review_result || {}, null, 2)}\n\nPR diff (context only):\n${diff.slice(0, 30000)}`;
}

function approvedVerificationCommands(workspace, configured) {
  const approved = new Map([
    ['npm test --if-present', ['npm', ['test', '--if-present']]],
    ['npm run lint --if-present', ['npm', ['run', 'lint', '--if-present']]],
    ['npm run typecheck --if-present', ['npm', ['run', 'typecheck', '--if-present']]],
    ['npm run build --if-present', ['npm', ['run', 'build', '--if-present']]],
    ['make test', ['make', ['test']]],
    ['make check', ['make', ['check']]],
  ]);
  const requested = Array.isArray(configured) && configured.length > 0
    ? configured
    : detectVerificationCommands(workspace);
  return requested.map((command) => ({ command, invocation: approved.get(command) || null }));
}

export function createFixRuntimeDeps({ taskDir, renewClaim, readTask }) {
  return {
    fetchCurrentHead: async (task) => (await ghApi('GET', `repos/${task.repository}/pulls/${task.pr}`, task.agent)).head.sha,
    readTask: async (task) => readTask({ dir: taskDir, id: task.id }),
    renewLease: async ({ dir, id, leaseId, leaseEpoch }) => renewClaim({ dir, id, leaseId, leaseEpoch }),
    prepareWorkspace: async (_task, binding) => {
      if (!binding?.workspace_path || binding?.record?.mode !== 'branch') {
        throw new Error('managed_fix_workspace_required');
      }
      return {
        hostWorkspace: binding.workspace_path,
        branchName: binding.record.branch,
        resolvedSha: binding.record.resolved_sha,
        managed: true,
      };
    },
    applyFix: async ({ task, workspace }) => {
      const diff = ghApiText('GET', `repos/${task.repository}/pulls/${task.pr}`, task.agent, ['Accept: application/vnd.github.v3.diff']);
      const files = parseFiles((await askAI(fixPrompt({ task, diff }))).trim());
      const workspaceRoot = resolve(workspace.hostWorkspace);
      let changed = false;
      for (const file of files) {
        if (!isSafeRelativePath(file.path)) continue;
        const destination = resolve(workspaceRoot, file.path);
        if (relative(workspaceRoot, destination).startsWith(`..${sep}`)) continue;
        await mkdir(resolve(destination, '..'), { recursive: true });
        await writeFile(destination, `${file.content}\n`, 'utf-8');
        changed = true;
      }
      if (!changed) return { changed: false };
      const status = runGit(workspace, ['status', '--short'], 10_000);
      return { changed: status.split('\n').some((line) => /^( M|M |A |\?\?)/.test(line) && !line.includes('.openab/')) };
    },
    verifyWorkspace: async ({ task, workspace }) => {
      const commands = approvedVerificationCommands(workspace, task.policy?.verify_commands);
      if (commands.length === 0 || commands.some((item) => !item.invocation)) {
        return { outcome: 'no_commands', checks: [], reason: 'No approved verification commands detected or configured' };
      }
      const outcomes = [];
      for (const item of commands) {
        const [executable, args] = item.invocation;
        try {
          const output = execFileSync(executable, args, {
            cwd: workspace.hostWorkspace,
            encoding: 'utf8', timeout: 120_000, stdio: 'pipe', windowsHide: true,
          });
          outcomes.push({ command: item.command, passed: true, output: output.slice(0, 2000) });
        } catch (error) {
          outcomes.push({ command: item.command, passed: false, error: String(error?.message || error).slice(0, 500) });
        }
      }
      return { outcome: outcomes.every((item) => item.passed) ? 'verified' : 'verification_failed', checks: outcomes };
    },
    pushWorkspace: async ({ task, workspace }) => {
      const bot = BOT_USERS[task.agent] || `lihsheng-${task.agent}[bot]`;
      const branch = workspace.branchName;
      runGit(workspace, ['config', 'user.name', bot], 10_000);
      runGit(workspace, ['config', 'user.email', `${bot}@users.noreply.github.com`], 10_000);
      runGit(workspace, ['add', '-A'], 10_000);
      runGit(workspace, ['commit', '-m', `Auto-fix: address PR review feedback for #${task.pr}`], 60_000);
      runGit(workspace, ['push', `--force-with-lease=refs/heads/${branch}:${task.reviewed_sha}`, 'origin', `HEAD:refs/heads/${branch}`], 120_000);
      return { newSha: runGit(workspace, ['rev-parse', 'HEAD'], 10_000) };
    },
    cleanupWorkspace: async () => {},
  };
}

function detectVerificationCommands(workspace) {
  const commands = [];
  try {
    const packagePath = join(workspace.hostWorkspace, 'package.json');
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (pkg.scripts?.test) commands.push('npm test --if-present');
      if (pkg.scripts?.lint) commands.push('npm run lint --if-present');
      if (pkg.scripts?.typecheck) commands.push('npm run typecheck --if-present');
      else if (pkg.scripts?.build) commands.push('npm run build --if-present');
    }
  } catch {}
  if (commands.length === 0 && existsSync(join(workspace.hostWorkspace, 'Makefile'))) {
    commands.push('make test');
  }
  return commands;
}
