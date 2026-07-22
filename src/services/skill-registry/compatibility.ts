import type { AgentProfile } from '../agent-profile/schema.js';
import type { SkillManifest } from './schema.js';

export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';
export type CredentialPresence = 'present' | 'missing' | 'unknown';
export type RequirementPresence = 'present' | 'missing' | 'unknown';
export type CompatibilityReasonCode =
  | 'unsupported_runtime'
  | 'missing_command'
  | 'missing_credential_reference'
  | 'runtime_data_unavailable'
  | 'credential_state_unknown'
  | 'manifest_unresolved';

export type CompatibilityReason = {
  code: CompatibilityReasonCode;
  subject?: string;
  message: string;
};

export type SkillCompatibility = {
  status: CompatibilityStatus;
  reasons: CompatibilityReason[];
  requirements: {
    commands: { name: string; status: RequirementPresence }[];
    credentials: { reference: string; status: CredentialPresence }[];
  };
};

const REASON_ORDER: Record<CompatibilityReasonCode, number> = {
  manifest_unresolved: 0,
  unsupported_runtime: 1,
  runtime_data_unavailable: 2,
  missing_command: 3,
  missing_credential_reference: 4,
  credential_state_unknown: 5,
};

function sortReasons(reasons: CompatibilityReason[]) {
  return reasons.sort((left, right) => (
    REASON_ORDER[left.code] - REASON_ORDER[right.code] ||
    String(left.subject || '').localeCompare(String(right.subject || ''))
  ));
}

export function evaluateSkillCompatibility({
  profile,
  manifest,
  commandPresence,
  credentialResolver,
}: {
  profile: AgentProfile;
  manifest: SkillManifest | null;
  commandPresence: Record<string, boolean> | null;
  credentialResolver: (reference: string) => CredentialPresence;
}): SkillCompatibility {
  if (!manifest) {
    return {
      status: 'unknown',
      reasons: [{ code: 'manifest_unresolved', message: 'The declared skill version could not be resolved.' }],
      requirements: { commands: [], credentials: [] },
    };
  }

  const reasons: CompatibilityReason[] = [];
  if (!manifest.supportedRuntimes.includes(profile.runtime.backend)) {
    reasons.push({
      code: 'unsupported_runtime',
      subject: profile.runtime.backend,
      message: `Runtime ${profile.runtime.backend} is not declared by this manifest.`,
    });
  }

  const commands = manifest.requiredCommands.map((name) => {
    if (commandPresence === null) return { name, status: 'unknown' as const };
    const present = commandPresence[name] === true;
    if (!present) reasons.push({ code: 'missing_command', subject: name, message: `Required command ${name} was not detected.` });
    return { name, status: present ? 'present' as const : 'missing' as const };
  });
  if (manifest.requiredCommands.length > 0 && commandPresence === null) {
    reasons.push({ code: 'runtime_data_unavailable', message: 'Command capability data is unavailable.' });
  }

  const credentials = manifest.requiredCredentials.map((reference) => {
    const status = credentialResolver(reference);
    if (status === 'missing') {
      reasons.push({
        code: 'missing_credential_reference',
        subject: reference,
        message: `Credential reference ${reference} is not configured as present.`,
      });
    } else if (status === 'unknown') {
      reasons.push({
        code: 'credential_state_unknown',
        subject: reference,
        message: `Credential reference ${reference} has unknown presence.`,
      });
    }
    return { reference, status };
  });

  sortReasons(reasons);
  const incompatible = reasons.some((reason) => [
    'unsupported_runtime', 'missing_command', 'missing_credential_reference',
  ].includes(reason.code));
  return {
    status: incompatible ? 'incompatible' : reasons.length ? 'unknown' : 'compatible',
    reasons,
    requirements: { commands, credentials },
  };
}
