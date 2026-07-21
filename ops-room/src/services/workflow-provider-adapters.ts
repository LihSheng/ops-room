import { spawn } from 'node:child_process';

import { getAgentProfile } from './agent-profile/registry.js';

const WORKFLOW_AGENTS = Object.freeze(['professor', 'tokyo', 'berlin']);
const MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024;
const PROVIDER_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'LANG',
  'LC_ALL',
  'NODE_PATH',
  'NODE_ENV',
  'NODE_OPTIONS',
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

function boundedOutputAppend(current: string, value: unknown, maximum: number) {
  const next = current + String(value ?? '');
  if (Buffer.byteLength(next, 'utf-8') > maximum) {
    throw new Error('workflow_provider_output_too_large');
  }
  return next;
}

export function buildWorkflowProviderEnv(source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PROVIDER_ENV_ALLOWLIST) {
    const value = source[key];
    if (value != null && value !== '') env[key] = value;
  }
  return env;
}

export function runWorkflowProviderProcess({
  command,
  args,
  cwd,
  stdin,
  env,
  signal,
  maximumOutputBytes = MAX_PROVIDER_OUTPUT_BYTES,
  spawnFn = spawn,
}: any) {
  if (signal?.aborted) return Promise.reject(new Error('workflow_provider_cancelled'));
  if (!command || !Array.isArray(args) || !cwd) {
    return Promise.reject(new Error('workflow_provider_process_input_invalid'));
  }

  return new Promise<string>((resolve, reject) => {
    let child: any;
    let stdout = '';
    let settled = false;
    let escalationTimer: NodeJS.Timeout | null = null;

    const cleanup = ({ keepEscalation = false } = {}) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!keepEscalation && escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
    };
    const finish = (operation: () => void, options: any = {}) => {
      if (settled) return;
      settled = true;
      cleanup(options);
      operation();
    };
    const terminate = () => {
      try { child?.kill('SIGTERM'); } catch {}
      escalationTimer = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch {}
      }, 5_000);
      escalationTimer.unref?.();
    };
    const onAbort = () => {
      terminate();
      finish(() => reject(new Error('workflow_provider_cancelled')), { keepEscalation: true });
    };

    try {
      child = spawnFn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish(() => reject(new Error('workflow_provider_process_unavailable')));
      return;
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: unknown) => {
      if (settled) return;
      try {
        stdout = boundedOutputAppend(stdout, chunk, maximumOutputBytes);
      } catch {
        terminate();
        finish(() => reject(new Error('workflow_provider_output_too_large')), { keepEscalation: true });
      }
    });
    child.stderr?.on('data', () => {
      // Intentionally discarded. Raw provider stderr may contain credentials or host details.
    });
    child.on('error', () => {
      finish(() => reject(new Error('workflow_provider_process_unavailable')));
    });
    child.on('close', (code: number | null, signalName: string | null) => {
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      if (settled) return;
      if (code === 0 && !signalName) {
        finish(() => resolve(stdout));
        return;
      }
      finish(() => reject(new Error('workflow_provider_process_failed')));
    });

    try {
      child.stdin?.end(String(stdin ?? ''), 'utf-8');
    } catch {
      terminate();
      finish(() => reject(new Error('workflow_provider_process_failed')), { keepEscalation: true });
    }
  });
}

function validateProfileAuthority({ profile, agent, run, child }: any) {
  if (!profile || profile.id !== agent) throw new Error('workflow_provider_profile_missing');
  if (!profile.enabled) throw new Error('workflow_provider_profile_disabled');
  if (child?.owner_agent !== agent) throw new Error('workflow_provider_profile_owner_mismatch');
  if (!Array.isArray(profile.repositories) || !profile.repositories.includes(run?.repository_id)) {
    throw new Error('workflow_provider_repository_not_allowed');
  }
  if (profile.runtime?.backend !== 'opencode') {
    throw new Error('workflow_provider_backend_unsupported');
  }
  return profile;
}

export function createProfileWorkflowProviderAdapters({
  profileLookup = getAgentProfile,
  processRunner = runWorkflowProviderProcess,
  envSource = process.env,
}: any = {}) {
  const adapters: Record<string, Function> = {};
  for (const agent of WORKFLOW_AGENTS) {
    adapters[agent] = async ({ prompt, cwd, signal, run, child }: any) => {
      const profile = validateProfileAuthority({
        profile: profileLookup(agent),
        agent,
        run,
        child,
      });
      return processRunner({
        command: profile.runtime.backend,
        args: ['run', '-'],
        cwd,
        stdin: prompt,
        env: buildWorkflowProviderEnv(envSource),
        signal,
      });
    };
  }
  return Object.freeze(adapters);
}

export { MAX_PROVIDER_OUTPUT_BYTES, PROVIDER_ENV_ALLOWLIST, WORKFLOW_AGENTS };
