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
export function joinProfileRuntime(profiles, instances) {
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
//# sourceMappingURL=profile-runtime-join.js.map