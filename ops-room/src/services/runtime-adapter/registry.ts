import { AGENT_DEFINITIONS } from '../agent-definitions.js';
import { createOpenABDockerRuntimeAdapter } from './openab-docker-adapter.js';
import { createDockerReadInspector } from './docker-read-inspector.js';
import {
  unknownRuntimeStatus,
  type AgentRuntimeAdapter,
  type RuntimeInspectionSnapshot,
} from './types.js';

const DEFAULT_RUNTIME_ADAPTERS = Object.freeze([
  createOpenABDockerRuntimeAdapter(),
]);

function validateAdapters(adapters: AgentRuntimeAdapter[]) {
  const ids = new Set();
  for (const adapter of adapters) {
    if (!adapter?.id || typeof adapter.supports !== 'function' || typeof adapter.prepare !== 'function' || typeof adapter.inspect !== 'function') {
      throw new Error('Invalid runtime adapter');
    }
    if (ids.has(adapter.id)) throw new Error(`Duplicate runtime adapter ID: ${adapter.id}`);
    ids.add(adapter.id);
  }
}

function selectAdapter(definition, adapters: AgentRuntimeAdapter[]) {
  const matches = adapters.filter((adapter) => adapter.supports(definition));
  if (matches.length === 0) throw new Error(`No runtime adapter supports agent ${definition.key}`);
  if (matches.length > 1) throw new Error(`Multiple runtime adapters support agent ${definition.key}`);
  return matches[0];
}

export function prepareAgentRuntimes({
  definitions = AGENT_DEFINITIONS,
  adapters = DEFAULT_RUNTIME_ADAPTERS,
} = {}) {
  validateAdapters(adapters as AgentRuntimeAdapter[]);
  return definitions.map((definition) => {
    const adapter = selectAdapter(definition, adapters as AgentRuntimeAdapter[]);
    return {
      definition,
      adapter,
      prepared: adapter.prepare(definition),
    };
  });
}

export function inspectAgentRuntimes({
  definitions = AGENT_DEFINITIONS,
  adapters = DEFAULT_RUNTIME_ADAPTERS,
} = {}): RuntimeInspectionSnapshot {
  const preparedRecords = prepareAgentRuntimes({ definitions, adapters });
  const recordsByAdapter = new Map();
  for (const record of preparedRecords) {
    const group = recordsByAdapter.get(record.adapter.id) || { adapter: record.adapter, records: [] };
    group.records.push(record);
    recordsByAdapter.set(record.adapter.id, group);
  }

  const inspections = new Map();
  const diagnostics = [];
  for (const { adapter, records } of recordsByAdapter.values()) {
    let inspection;
    try {
      inspection = adapter.inspect(records.map((record) => record.prepared));
    } catch {
      inspection = {
        adapter_id: adapter.id,
        available: false,
        error: 'runtime adapter inspection failed',
        fetched_at: Date.now(),
        runtimes: {},
      };
    }
    inspections.set(adapter.id, inspection);
    diagnostics.push({
      adapter_id: adapter.id,
      available: Boolean(inspection.available),
      error: inspection.error || null,
      fetched_at: inspection.fetched_at,
    });
  }

  return {
    instances: preparedRecords.map(({ definition, adapter, prepared }) => {
      const runtime = inspections.get(adapter.id)?.runtimes?.[definition.key] || unknownRuntimeStatus();
      return {
        agent: definition.key,
        adapter_id: adapter.id,
        definition,
        prepared,
        runtime,
      };
    }),
    adapters: diagnostics,
  };
}

export function getDefaultRuntimeAdapters() {
  return [...DEFAULT_RUNTIME_ADAPTERS];
}

/**
 * Create a runtime inspector factory that bypasses the 5-second cache.
 * Used in production by http.ts as the freshRuntimeSnapshot parameter
 * to prevent false convergence timeouts when the cached inspector
 * has not yet observed the post-start state change.
 */
export function createFreshRuntimeInspector() {
  const freshInspector = createDockerReadInspector({ cacheMs: 0 });
  const freshAdapter = createOpenABDockerRuntimeAdapter({ inspector: freshInspector });
  return (overrides = {}) => inspectAgentRuntimes({
    definitions: AGENT_DEFINITIONS,
    adapters: [freshAdapter],
    ...overrides,
  });
}
