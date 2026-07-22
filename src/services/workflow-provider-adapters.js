import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getAgentProfile } from './agent-profile/registry.js';
const execFileDefault = promisify(execFileCallback);
const WORKFLOW_AGENTS = Object.freeze(['professor', 'tokyo', 'berlin']);
const MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024;
const MAX_REMOTE_LENGTH = 2_048;
const PROVIDER_TERMINATION_ESCALATION_MS = 5_000;
// settle_gap is intentionally unused — the stage runner's own
// invokeWithDeadline terminationGraceMs is the authoritative
// deadline for unconfirmed child termination. The subprocess
// promise stays pending until the child emits close/error so
// invokeWithDeadline can distinguish acknowledged shutdown
// (rejected with terminationReason) from unconfirmed-zombie
// shutdown (termination grace expiry).
const PROVIDER_TERMINATION_SETTLE_MS = 7_000;
const UNSAFE_GIT_CONFIG_KEY = /^(?:credential\.|http\.|url\.|include\.|includeif\.|core\.sshcommand$|remote\..*\.pushurl$)/i;
const PROVIDER_ENV_ALLOWLIST = new Set([
    'PATH',
    'USER',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'LANG',
    'LC_ALL',
    'NODE_ENV',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENCODE_API_KEY',
    'OPENCODE_MODEL',
    'OPENCODE_MAX_TOKENS',
    'OPENCODE_MAX_TOKEN',
    'NVIDIA_API_KEY',
    'NVIDIA_MODEL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
]);
function boundedOutputAppend(current, value, maximum) {
    const next = current + String(value ?? '');
    if (Buffer.byteLength(next, 'utf-8') > maximum) {
        throw new Error('workflow_provider_output_too_large');
    }
    return next;
}
function splitLines(value) {
    return String(value ?? '')
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function splitNulls(value) {
    return String(value ?? '')
        .split('\0')
        .map((entry) => entry.trim())
        .filter(Boolean);
}
export function buildWorkflowProviderEnv(source = process.env) {
    const env = {};
    for (const key of PROVIDER_ENV_ALLOWLIST) {
        const value = source[key];
        if (value != null && value !== '')
            env[key] = value;
    }
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'never';
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env.GH_PROMPT_DISABLED = '1';
    return env;
}
export function validateWorkflowProviderRemote(value) {
    const remote = String(value ?? '').trim();
    if (!remote || remote.length > MAX_REMOTE_LENGTH || /[\r\n]/.test(remote)) {
        throw new Error('workflow_provider_remote_invalid');
    }
    if (/^(?:git@|ssh:|git:)/i.test(remote)) {
        throw new Error('workflow_provider_remote_credentials_unsafe');
    }
    let parsed;
    try {
        parsed = new URL(remote);
    }
    catch {
        throw new Error('workflow_provider_remote_invalid');
    }
    if (parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash) {
        throw new Error('workflow_provider_remote_credentials_unsafe');
    }
    return remote;
}
export function validateWorkflowProviderGitConfig(keys) {
    for (const value of keys) {
        const key = String(value ?? '').trim();
        if (key && UNSAFE_GIT_CONFIG_KEY.test(key)) {
            throw new Error('workflow_provider_git_config_unsafe');
        }
    }
}
export async function readWorkflowWorkspaceRemote({ cwd, execFile = execFileDefault }) {
    const env = buildWorkflowProviderEnv(process.env);
    const options = {
        cwd,
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 32 * 1024,
        windowsHide: true,
        env,
    };
    try {
        const [fetchResult, pushResult, configResult] = await Promise.all([
            execFile('git', ['remote', 'get-url', '--all', 'origin'], options),
            execFile('git', ['remote', 'get-url', '--push', '--all', 'origin'], options),
            execFile('git', ['config', '--name-only', '--null', '--list'], options),
        ]);
        const fetchRemotes = splitLines(fetchResult?.stdout);
        const pushRemotes = splitLines(pushResult?.stdout);
        if (fetchRemotes.length === 0 || pushRemotes.length === 0) {
            throw new Error('workflow_provider_remote_unavailable');
        }
        for (const remote of [...fetchRemotes, ...pushRemotes]) {
            validateWorkflowProviderRemote(remote);
        }
        validateWorkflowProviderGitConfig(splitNulls(configResult?.stdout));
        return fetchRemotes[0];
    }
    catch (error) {
        if (String(error?.message || '').startsWith('workflow_provider_'))
            throw error;
        throw new Error('workflow_provider_remote_unavailable');
    }
}
async function withIsolatedProviderHome(envSource, execute) {
    const isolationRoot = await mkdtemp(join(tmpdir(), 'ops-room-provider-'));
    const providerHome = join(isolationRoot, 'home');
    const configHome = join(providerHome, '.config');
    const cacheHome = join(providerHome, '.cache');
    const dataHome = join(providerHome, '.local', 'share');
    const ghConfigDir = join(configHome, 'gh');
    await Promise.all([
        mkdir(ghConfigDir, { recursive: true }),
        mkdir(cacheHome, { recursive: true }),
        mkdir(dataHome, { recursive: true }),
    ]);
    const env = buildWorkflowProviderEnv(envSource);
    env.HOME = providerHome;
    env.USERPROFILE = providerHome;
    env.XDG_CONFIG_HOME = configHome;
    env.XDG_CACHE_HOME = cacheHome;
    env.XDG_DATA_HOME = dataHome;
    env.GH_CONFIG_DIR = ghConfigDir;
    try {
        return await execute(env);
    }
    finally {
        await rm(isolationRoot, { recursive: true, force: true }).catch(() => { });
    }
}
export function runWorkflowProviderProcess({ command, args, cwd, stdin, env, signal, maximumOutputBytes = MAX_PROVIDER_OUTPUT_BYTES, spawnFn = spawn, }) {
    if (signal?.aborted)
        return Promise.reject(new Error('workflow_provider_cancelled'));
    if (!command || !Array.isArray(args) || !cwd) {
        return Promise.reject(new Error('workflow_provider_process_input_invalid'));
    }
    return new Promise((resolve, reject) => {
        let child;
        let stdout = '';
        let settled = false;
        let terminationReason = null;
        let escalationTimer = null;
        const cleanup = () => {
            if (signal)
                signal.removeEventListener('abort', onAbort);
            if (escalationTimer)
                clearTimeout(escalationTimer);
            escalationTimer = null;
        };
        const finish = (operation) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            operation();
        };
        const requestTermination = (reason) => {
            if (settled || terminationReason)
                return;
            terminationReason = reason;
            try {
                child?.kill('SIGTERM');
            }
            catch { }
            escalationTimer = setTimeout(() => {
                try {
                    child?.kill('SIGKILL');
                }
                catch { }
            }, PROVIDER_TERMINATION_ESCALATION_MS);
            escalationTimer.unref?.();
            // Intentionally do NOT settle here. The promise stays pending
            // until the child emits close/error, so the stage runner's
            // invokeWithDeadline can distinguish acknowledged shutdown
            // (rejected with terminationReason) from an unconfirmed-zombie
            // shutdown (termination_grace expiry → workflow_provider_termination_failed).
        };
        const onAbort = () => requestTermination('workflow_provider_cancelled');
        try {
            child = spawnFn(command, args, {
                cwd,
                env,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch {
            finish(() => reject(new Error('workflow_provider_process_unavailable')));
            return;
        }
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted)
                onAbort();
        }
        child.stdout?.on('data', (chunk) => {
            if (settled || terminationReason)
                return;
            try {
                stdout = boundedOutputAppend(stdout, chunk, maximumOutputBytes);
            }
            catch {
                requestTermination('workflow_provider_output_too_large');
            }
        });
        child.stderr?.on('data', () => {
            // Intentionally discarded. Raw provider stderr may contain credentials or host details.
        });
        child.stdin?.on?.('error', () => {
            requestTermination('workflow_provider_process_failed');
        });
        child.on('error', () => {
            finish(() => reject(new Error(terminationReason || 'workflow_provider_process_unavailable')));
        });
        child.on('close', (code, signalName) => {
            if (settled)
                return;
            if (terminationReason) {
                finish(() => reject(new Error(terminationReason)));
                return;
            }
            if (code === 0 && !signalName) {
                finish(() => resolve(stdout));
                return;
            }
            finish(() => reject(new Error('workflow_provider_process_failed')));
        });
        if (!terminationReason) {
            try {
                child.stdin?.end(String(stdin ?? ''), 'utf-8');
            }
            catch {
                requestTermination('workflow_provider_process_failed');
            }
        }
    });
}
function validateProfileAuthority({ profile, agent, run, child }) {
    if (!profile || profile.id !== agent)
        throw new Error('workflow_provider_profile_missing');
    if (!profile.enabled)
        throw new Error('workflow_provider_profile_disabled');
    if (child?.owner_agent !== agent)
        throw new Error('workflow_provider_profile_owner_mismatch');
    if (!Array.isArray(profile.repositories) || !profile.repositories.includes(run?.repository_id)) {
        throw new Error('workflow_provider_repository_not_allowed');
    }
    if (profile.runtime?.backend !== 'opencode') {
        throw new Error('workflow_provider_backend_unsupported');
    }
    return profile;
}
export function createProfileWorkflowProviderAdapters({ profileLookup = getAgentProfile, processRunner = runWorkflowProviderProcess, remoteInspector = readWorkflowWorkspaceRemote, envSource = process.env, } = {}) {
    const adapters = {};
    for (const agent of WORKFLOW_AGENTS) {
        adapters[agent] = async ({ prompt, cwd, signal, run, child }) => {
            const profile = validateProfileAuthority({
                profile: profileLookup(agent),
                agent,
                run,
                child,
            });
            validateWorkflowProviderRemote(await remoteInspector({ cwd, run, child }));
            return withIsolatedProviderHome(envSource, (isolatedEnv) => processRunner({
                command: profile.runtime.backend,
                args: ['run', '-'],
                cwd,
                stdin: prompt,
                env: isolatedEnv,
                signal,
            }));
        };
    }
    return Object.freeze(adapters);
}
export { MAX_PROVIDER_OUTPUT_BYTES, PROVIDER_ENV_ALLOWLIST, PROVIDER_TERMINATION_ESCALATION_MS, PROVIDER_TERMINATION_SETTLE_MS, UNSAFE_GIT_CONFIG_KEY, WORKFLOW_AGENTS, };
//# sourceMappingURL=workflow-provider-adapters.js.map