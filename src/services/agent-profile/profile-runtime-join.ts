/**
 * Join profile policy and runtime data by agent ID.
 *
 * - Every runtime instance and every profile contributes a row.
 * - Rows are sorted deterministically by agent ID.
 * - Missing profile or runtime is represented as `null` in its field.
 *
 * This function lives under `src/services/` so both server-side tests and the
 * frontend dashboard can import the same production implementation.
 */

export interface ProfileRecord {
  id: string;
}

export interface RuntimeRecord {
  agent: string;
}

export interface JoinedRow<P extends ProfileRecord, R extends RuntimeRecord> {
  id: string;
  profile: P | null;
  runtime: R | null;
}

export function joinProfileRuntime<P extends ProfileRecord, R extends RuntimeRecord>(
  profiles: P[],
  instances: R[],
): JoinedRow<P, R>[] {
  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const instanceMap = new Map(instances.map((i) => [i.agent, i]));
  const allIds = new Set([
    ...instances.map((i) => i.agent),
    ...profiles.map((p) => p.id),
  ]);
  return [...allIds]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      profile: profileMap.get(id) ?? null,
      runtime: instanceMap.get(id) ?? null,
    }));
}
