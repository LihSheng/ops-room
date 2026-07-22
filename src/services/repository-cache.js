import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { withWorkspaceLock } from './workspace-locks.js';
const execFileDefault = promisify(execFileCallback);
const SAFE_LEGACY_REPOSITORY_ID = /^[A-Za-z0-9._-]{1,120}$/;
const SAFE_CANONICAL_REPOSITORY_ID = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const SAFE_REF = /^[A-Za-z0-9._\/-]{1,240}$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
export function validateRepositoryId(value) {
    const repositoryId = String(value || '').trim();
    if (!(SAFE_LEGACY_REPOSITORY_ID.test(repositoryId) || SAFE_CANONICAL_REPOSITORY_ID.test(repositoryId))) {
        throw new Error('invalid_repository_id');
    }
    // Reject path traversal sequences: '..', leading/trailing dots, or dot-separated '.' segments
    if (repositoryId.includes('..') || repositoryId.startsWith('.') || repositoryId.endsWith('.')) {
        throw new Error('invalid_repository_id');
    }
    return repositoryId;
}
export function repositoryCacheKey(repositoryId) {
    const validated = validateRepositoryId(repositoryId);
    const readable = validated.replace('/', '--').slice(0, 80);
    const digest = createHash('sha256').update(validated).digest('hex').slice(0, 16);
    return `${readable}-${digest}`;
}
export function assertPathWithinRoot(root, candidate) {
    const resolvedRoot = resolve(root);
    const resolvedCandidate = resolve(candidate);
    if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
        throw new Error('workspace_path_escape');
    }
    return resolvedCandidate;
}
export function repositoryCachePath(cacheRoot, repositoryId) {
    return assertPathWithinRoot(cacheRoot, join(cacheRoot, `${repositoryCacheKey(repositoryId)}.git`));
}
async function runGit(execFile, args, options = {}) {
    try {
        const result = await execFile('git', args, {
            cwd: options.cwd,
            encoding: 'utf8',
            timeout: options.timeoutMs || 60_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return String(result?.stdout || '').trim();
    }
    catch {
        throw new Error(options.errorCode || 'git_command_failed');
    }
}
export async function ensureRepositoryCache({ cacheRoot, lockRoot, repositoryId, remote, execFile = execFileDefault, }) {
    const canonicalRepositoryId = validateRepositoryId(repositoryId);
    if (!remote || /[\r\n]/.test(remote))
        throw new Error('invalid_repository_remote');
    await mkdir(cacheRoot, { recursive: true });
    const cacheKey = repositoryCacheKey(canonicalRepositoryId);
    const cachePath = repositoryCachePath(cacheRoot, canonicalRepositoryId);
    return withWorkspaceLock({
        dir: lockRoot,
        name: `repository-${cacheKey}`,
        execute: async () => {
            let exists = false;
            try {
                exists = (await stat(cachePath)).isDirectory();
            }
            catch (error) {
                if (error?.code !== 'ENOENT')
                    throw error;
            }
            if (!exists) {
                await mkdir(dirname(cachePath), { recursive: true });
                await runGit(execFile, ['clone', '--bare', '--', remote, cachePath], {
                    errorCode: 'repository_cache_clone_failed',
                });
            }
            else {
                await runGit(execFile, ['--git-dir', cachePath, 'fetch', '--prune', '--tags', 'origin'], {
                    errorCode: 'repository_cache_fetch_failed',
                });
            }
            return { repository_id: canonicalRepositoryId, cache_key: cacheKey, cache_path: cachePath };
        },
    });
}
export async function resolveRepositoryRevision({ cachePath, revision, execFile = execFileDefault }) {
    if (!(SAFE_SHA.test(revision) || SAFE_REF.test(revision)))
        throw new Error('invalid_repository_revision');
    const resolved = await runGit(execFile, ['--git-dir', cachePath, 'rev-parse', '--verify', `${revision}^{commit}`], {
        errorCode: 'repository_revision_unavailable',
    });
    if (!SAFE_SHA.test(resolved))
        throw new Error('repository_revision_unavailable');
    return resolved.toLowerCase();
}
export async function assertExistingPathWithinRoot(root, candidate) {
    const checked = assertPathWithinRoot(root, candidate);
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) {
        throw new Error('workspace_symlink_escape');
    }
    return checked;
}
//# sourceMappingURL=repository-cache.js.map