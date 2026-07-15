import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { BOT_USERS } from '../lib/config.mjs';
import { FORBIDDEN_FILE_PATTERNS } from '../services/runtime-paths.mjs';
import { ghApi, ghApiText } from '../services/github.mjs';
import { askAI } from './chat-response.mjs';
import { prepareFixWorkspace } from './auto-fix.mjs';

function docker(container, command, timeout = 60_000) {
  return execFileSync('docker', ['exec', container, 'bash', '-c', command], { encoding: 'utf-8', timeout, stdio: 'pipe' });
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

export function createFixRuntimeDeps({ taskDir, renewClaim, readTask }) {
  return {
    fetchCurrentHead: async (task) => (await ghApi('GET', `repos/${task.repository}/pulls/${task.pr}`, task.agent)).head.sha,
    readTask: async (task) => readTask({ dir: taskDir, id: task.id }),
    renewLease: async (task) => renewClaim({ dir: taskDir, id: task.id }),
    prepareWorkspace: async (task) => {
      const pr = await ghApi('GET', `repos/${task.repository}/pulls/${task.pr}`, task.agent);
      return prepareFixWorkspace(task.repository, task.pr, task.agent, pr.head.ref);
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
      const status = docker(workspace.container, `cd "${workspace.containerWorkspace}" && git status --short`, 10_000);
      return { changed: status.split('\n').some((line) => /^( M|M |A |\?\?)/.test(line) && !line.includes('.openab/')) };
    },
    pushWorkspace: async ({ task, workspace }) => {
      const bot = BOT_USERS[task.agent] || `lihsheng-${task.agent}[bot]`;
      const branch = workspace.branchName;
      const command = `cd "${workspace.containerWorkspace}" && git config user.name "${bot}" && git config user.email "${bot}@users.noreply.github.com" && git add -A && git commit -m "Auto-fix: address PR review feedback for #${task.pr}" && git push --force-with-lease=refs/heads/${branch}:${task.reviewed_sha} origin HEAD:refs/heads/${branch} && git rev-parse HEAD`;
      const newSha = docker(workspace.container, command).trim().split('\n').at(-1);
      return { newSha };
    },
    cleanupWorkspace: async ({ workspace }) => {
      if (!workspace) return;
      try { docker(workspace.container, `rm -rf "${workspace.containerWorkspace}"`, 10_000); } finally {
        await rm(workspace.hostWorkspace, { recursive: true, force: true });
      }
    },
  };
}
