import { appendAuditEvent } from '../services/audit-log.js';
import { getAgentDefinition } from '../services/agent-definitions.js';
import {
  agentLifecycleAllowsDispatch,
  classifyConvergence,
  readAgentLifecycleState,
  updateAgentLifecycleState,
  withAgentLifecycleGate,
} from '../services/agent-lifecycle-store.js';
import {
  executeIdempotent,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  validateIdempotencyKey,
} from '../services/idempotency-store.js';
import { scanReviewTasks } from '../services/review-task-store.js';
import { inspectAgentRuntimes } from '../services/runtime-adapter/registry.js';
import { prepareAgentLifecycleTarget } from '../services/runtime-lifecycle/registry.js';

const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;
const ACTIVE_TASK_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING', 'CANCEL_REQUESTED']);
const STOPPED_RUNTIME_STATES = new Set(['exited', 'dead', 'missing', 'stopped']);
const STARTABLE_RUNTIME_STATES = new Set(['exited', 'dead', 'stopped']);
let lifecycleActionQueue = Promise.resolve();

function reasonFrom(body) {
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length > 500) throw new Error('reason is required and must not exceed 500 characters');
  return reason;
}

function confirmationFrom(body, agentId) {
  const confirmation = String(body?.confirm_agent_id || '').trim();
  if (confirmation !== agentId) throw new Error('confirm_agent_id must exactly match the target agent');
  return confirmation;
}

function normalizeAllowedAgents(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

async function withLifecycleActionLock(execute) {
  const previous = lifecycleActionQueue;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  lifecycleActionQueue = previous.then(() => gate);
  await previous;
  try {
    return await execute();
  } finally {
    release();
  }
}

function observedRuntime(snapshot, agentId) {
  const instance = (snapshot?.instances || []).find((entry) => (
    entry?.agent === agentId || entry?.agent_id === agentId || entry?.definition?.key === agentId
  ));
  return {
    adapter_id: instance?.adapter_id || null,
    status: instance?.runtime?.status || 'unknown',
  };
}

function inspectObservedRuntime(getRuntimeSnapshot, agentId, fallbackAdapterId = null) {
  try {
    return observedRuntime(getRuntimeSnapshot(), agentId);
  } catch {
    return { adapter_id: fallbackAdapterId, status: 'unknown' };
  }
}

async function waitForAgentDrain({
  reviewTasksDir,
  agentId,
  timeoutMs,
  pollMs,
  scanTasks,
  now,
  sleep,
}) {
  const startedAt = now();
  let initialActive = null;
  while (true) {
    const scanned = await scanTasks({ dir: reviewTasksDir });
    if ((scanned.corrupt || []).length > 0) {
      return {
        drained: false,
        error_code: 'task_store_corrupt',
        active_count: initialActive || 0,
        remaining_count: 0,
      };
    }
    const active = (scanned.tasks || []).filter((task) => (
      task.agent === agentId && ACTIVE_TASK_STATES.has(task.state)
    ));
    if (initialActive === null) initialActive = active.length;
    if (active.length === 0) {
      return {
        drained: true,
        active_count: initialActive,
        remaining_count: 0,
        waited_ms: Math.max(0, now() - startedAt),
      };
    }
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      return {
        drained: false,
        error_code: 'agent_not_drained',
        active_count: initialActive,
        remaining_count: active.length,
        waited_ms: Math.max(0, elapsed),
      };
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)));
  }
}

async function rejected({
  auditDir,
  actor,
  agentId,
  reason,
  idempotencyKey,
  errorCode,
  status,
  message,
  previousState = null,
  resultingState = previousState,
  metadata = {},
  operation = 'agent.stop',
}) {
  const event = await appendAuditEvent({
    dir: auditDir,
    operation,
    actor,
    target: { type: 'agent', id: String(agentId || '').slice(0, 100) },
    reason,
    idempotencyKey,
    previousState,
    resultingState,
    outcome: 'rejected',
    errorCode,
    metadata,
  });
  return {
    status,
    body: {
      error: message,
      error_code: errorCode,
      audit_event_id: event.event_id,
    },
  };
}

async function acceptedAlreadyStopped({
  auditDir,
  actor,
  agentId,
  reason,
  idempotencyKey,
  current,
  observed,
  target,
}) {
  const event = await appendAuditEvent({
    dir: auditDir,
    operation: 'agent.stop',
    actor,
    target: { type: 'agent', id: agentId },
    reason,
    idempotencyKey,
    previousState: current.phase,
    resultingState: current.phase,
    outcome: 'accepted',
    metadata: {
      runtime_adapter: observed.adapter_id || target.runtime_adapter_id,
      lifecycle_controller: target.controller.id,
      observed_state_before: observed.status,
      command_executed: false,
      already_desired_state: true,
      active_task_count: 0,
      drain_waited_ms: 0,
    },
  });
  return {
    status: 202,
    body: {
      operation: 'agent.stop',
      agent: {
        id: agentId,
        desired_state: current.desired_state,
        lifecycle_state: current.phase,
        observed_state_before: observed.status,
      },
      command_executed: false,
      audit_event_id: event.event_id,
    },
  };
}

export async function handleOperatorAgentStop({
  agentId,
  body,
  actor,
  reviewTasksDir,
  lifecycleDir,
  auditDir,
  idempotencyDir,
  allowedAgents = [],
  drainTimeoutMs = 30_000,
  drainPollMs = 500,
  stopTimeoutSeconds = 30,
  getRuntimeSnapshot = inspectAgentRuntimes,
  prepareTarget = prepareAgentLifecycleTarget,
  scanTasks = scanReviewTasks,
  now = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const rawAgentId = String(agentId || '');
  let reason = String(body?.reason || '').trim().slice(0, 500);
  let idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).trim() : null;

  if (!SAFE_AGENT_ID.test(rawAgentId)) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'invalid_agent_id', status: 400, message: 'Invalid agent ID',
    });
  }

  if (!getAgentDefinition(rawAgentId)) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'agent_not_found', status: 404, message: 'Agent not found',
    });
  }

  if (!normalizeAllowedAgents(allowedAgents).has(rawAgentId)) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'agent_not_allowed', status: 403,
      message: 'Agent lifecycle control is not approved for this agent',
    });
  }

  let confirmation;
  try {
    reason = reasonFrom(body);
    confirmation = confirmationFrom(body, rawAgentId);
    idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
  } catch (error) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'invalid_request', status: 400, message: error.message,
    });
  }

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actor.actor_id,
      operation: 'agent.stop',
      targetId: rawAgentId,
      key: idempotencyKey,
      payload: { reason, confirm_agent_id: confirmation },
      execute: () => withLifecycleActionLock(() => withAgentLifecycleGate(rawAgentId, async () => {
        const current = await readAgentLifecycleState({ dir: lifecycleDir, agentId: rawAgentId });
        if (current.last_error === 'lifecycle_state_unavailable') {
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: 'lifecycle_state_unavailable', status: 409,
            message: 'Lifecycle state is unavailable', previousState: current.phase,
          });
        }

        let target;
        try {
          target = prepareTarget(rawAgentId);
        } catch {
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: 'lifecycle_target_unavailable', status: 409,
            message: 'Lifecycle target is unavailable', previousState: current.phase,
          });
        }

        const observed = inspectObservedRuntime(
          getRuntimeSnapshot,
          rawAgentId,
          target.runtime_adapter_id || null,
        );

        if (current.desired_state === 'stopped' && current.phase === 'stopped') {
          return acceptedAlreadyStopped({
            auditDir,
            actor,
            agentId: rawAgentId,
            reason,
            idempotencyKey,
            current,
            observed,
            target,
          });
        }

        const requestedAt = nowIso();
        await updateAgentLifecycleState({
          dir: lifecycleDir,
          agentId: rawAgentId,
          now: nowIso,
          patch: {
            desired_state: 'stopped',
            phase: 'draining',
            previous_desired_state: current.desired_state,
            last_error: null,
            last_operation: {
              operation: 'agent.stop',
              actor_id: actor.actor_id,
              reason,
              requested_at: requestedAt,
              outcome: 'in_progress',
            },
          },
        });

        const drain = await waitForAgentDrain({
          reviewTasksDir,
          agentId: rawAgentId,
          timeoutMs: Math.max(0, Number(drainTimeoutMs) || 0),
          pollMs: Math.max(1, Number(drainPollMs) || 1),
          scanTasks,
          now,
          sleep,
        });

        if (!drain.drained) {
          await updateAgentLifecycleState({
            dir: lifecycleDir,
            agentId: rawAgentId,
            now: nowIso,
            patch: {
              desired_state: current.desired_state,
              phase: 'failed',
              previous_desired_state: null,
              last_error: drain.error_code,
              last_operation: {
                operation: 'agent.stop',
                actor_id: actor.actor_id,
                reason,
                requested_at: requestedAt,
                completed_at: nowIso(),
                outcome: 'rejected',
              },
            },
          });
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: drain.error_code, status: 409,
            message: drain.error_code === 'task_store_corrupt'
              ? 'Cannot prove agent drain because task state is corrupt'
              : 'Agent still has active tasks',
            previousState: current.phase,
            resultingState: 'failed',
            metadata: {
              active_task_count: drain.active_count,
              remaining_task_count: drain.remaining_count,
              waited_ms: drain.waited_ms || 0,
            },
          });
        }

        await updateAgentLifecycleState({
          dir: lifecycleDir,
          agentId: rawAgentId,
          now: nowIso,
          patch: { desired_state: 'stopped', phase: 'stopping', last_error: null },
        });

        const commandExecuted = !STOPPED_RUNTIME_STATES.has(observed.status);
        let controllerResult = { controller_id: target.controller.id, action: 'stop' };
        if (commandExecuted) {
          try {
            controllerResult = await target.controller.stop(target.prepared, {
              timeoutSeconds: stopTimeoutSeconds,
            });
          } catch {
            await updateAgentLifecycleState({
              dir: lifecycleDir,
              agentId: rawAgentId,
              now: nowIso,
              patch: {
                desired_state: current.desired_state,
                phase: 'failed',
                previous_desired_state: null,
                last_error: 'runtime_stop_failed',
                last_operation: {
                  operation: 'agent.stop',
                  actor_id: actor.actor_id,
                  reason,
                  requested_at: requestedAt,
                  completed_at: nowIso(),
                  outcome: 'failed',
                },
              },
            });
            return rejected({
              auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
              errorCode: 'runtime_stop_failed', status: 502,
              message: 'Agent runtime stop failed', previousState: current.phase,
              resultingState: 'failed',
              metadata: {
                runtime_adapter: observed.adapter_id,
                lifecycle_controller: target.controller.id,
                active_task_count: drain.active_count,
              },
            });
          }
        }

        const lifecycle = await updateAgentLifecycleState({
          dir: lifecycleDir,
          agentId: rawAgentId,
          now: nowIso,
          patch: {
            desired_state: 'stopped',
            phase: 'stopped',
            previous_desired_state: null,
            last_error: null,
            last_operation: {
              operation: 'agent.stop',
              actor_id: actor.actor_id,
              reason,
              requested_at: requestedAt,
              completed_at: nowIso(),
              outcome: 'accepted',
            },
          },
        });

        const event = await appendAuditEvent({
          dir: auditDir,
          operation: 'agent.stop',
          actor,
          target: { type: 'agent', id: rawAgentId },
          reason,
          idempotencyKey,
          previousState: current.phase,
          resultingState: lifecycle.phase,
          outcome: 'accepted',
          metadata: {
            runtime_adapter: observed.adapter_id || target.runtime_adapter_id,
            lifecycle_controller: controllerResult.controller_id,
            observed_state_before: observed.status,
            command_executed: commandExecuted,
            active_task_count: drain.active_count,
            drain_waited_ms: drain.waited_ms,
          },
        });

        return {
          status: 202,
          body: {
            operation: 'agent.stop',
            agent: {
              id: rawAgentId,
              desired_state: lifecycle.desired_state,
              lifecycle_state: lifecycle.phase,
              observed_state_before: observed.status,
            },
            command_executed: commandExecuted,
            audit_event_id: event.event_id,
          },
        };
      })),
    });

    return {
      status: result.response.status,
      body: { ...result.response.body, idempotent_replay: result.replayed },
    };
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
      const current = await readAgentLifecycleState({ dir: lifecycleDir, agentId: rawAgentId });
      return rejected({
        auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
        errorCode: error.code, status: 409, message: error.message,
        previousState: current.phase,
      });
    }
    throw error;
  }
}

async function acceptedAlreadyRunning({
  auditDir,
  actor,
  agentId,
  reason,
  idempotencyKey,
  current,
  observed,
  target,
  convergence,
}) {
  const event = await appendAuditEvent({
    dir: auditDir,
    operation: 'agent.start',
    actor,
    target: { type: 'agent', id: agentId },
    reason,
    idempotencyKey,
    previousState: current.phase,
    resultingState: current.phase,
    outcome: 'accepted',
    metadata: {
      runtime_adapter: observed.adapter_id || target.runtime_adapter_id,
      lifecycle_controller: target.controller.id,
      observed_state_before: observed.status,
      command_executed: false,
      already_running: true,
      convergence_status: convergence.status,
      convergence_reason: convergence.reason_code,
    },
  });
  return {
    status: 202,
    body: {
      operation: 'agent.start',
      agent: {
        id: agentId,
        desired_state: current.desired_state,
        lifecycle_state: current.phase,
        observed_state_before: observed.status,
      },
      command_executed: false,
      audit_event_id: event.event_id,
    },
  };
}

export async function handleOperatorAgentStart({
  agentId,
  body,
  actor,
  reviewTasksDir,
  lifecycleDir,
  auditDir,
  idempotencyDir,
  allowedAgents = [],
  startTimeoutSeconds = 30,
  getRuntimeSnapshot = inspectAgentRuntimes,
  prepareTarget = prepareAgentLifecycleTarget,
  scanTasks = scanReviewTasks,
  now = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const rawAgentId = String(agentId || '');
  let reason = String(body?.reason || '').trim().slice(0, 500);
  let idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).trim() : null;

  if (!SAFE_AGENT_ID.test(rawAgentId)) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'invalid_agent_id', status: 400, message: 'Invalid agent ID',
      operation: 'agent.start',
    });
  }

  if (!getAgentDefinition(rawAgentId)) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'agent_not_found', status: 404, message: 'Agent not found',
      operation: 'agent.start',
    });
  }

  if (!normalizeAllowedAgents(allowedAgents).has(rawAgentId)) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'agent_not_allowed', status: 403,
      message: 'Agent lifecycle control is not approved for this agent',
      operation: 'agent.start',
    });
  }

  let confirmation;
  try {
    reason = reasonFrom(body);
    confirmation = confirmationFrom(body, rawAgentId);
    idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
  } catch (error) {
    return rejected({
      auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
      errorCode: 'invalid_request', status: 400, message: error.message,
      operation: 'agent.start',
    });
  }

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actor.actor_id,
      operation: 'agent.start',
      targetId: rawAgentId,
      key: idempotencyKey,
      payload: { reason, confirm_agent_id: confirmation },
      execute: () => withLifecycleActionLock(() => withAgentLifecycleGate(rawAgentId, async () => {
        const current = await readAgentLifecycleState({ dir: lifecycleDir, agentId: rawAgentId });
        if (current.last_error === 'lifecycle_state_unavailable') {
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: 'lifecycle_state_unavailable', status: 409,
            message: 'Lifecycle state is unavailable', previousState: current.phase,
            operation: 'agent.start',
          });
        }

        let target;
        try {
          target = prepareTarget(rawAgentId);
        } catch {
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: 'lifecycle_target_unavailable', status: 409,
            message: 'Lifecycle target is unavailable', previousState: current.phase,
            operation: 'agent.start',
          });
        }

        const observed = inspectObservedRuntime(
          getRuntimeSnapshot,
          rawAgentId,
          target.runtime_adapter_id || null,
        );

        // === Adoption: durable desired=running + phase=running requires observed running ===
        if (current.desired_state === 'running' && current.phase === 'running') {
          if (observed.status === 'running') {
            // Already running and healthy — audited no-op adoption
            const convergence = classifyConvergence(current.desired_state, current.phase, observed.status);
            return acceptedAlreadyRunning({
              auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
              current, observed, target, convergence,
            });
          }
          // Durable running but observed not running — mismatch, not adoption
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: 'lifecycle_mismatch', status: 409,
            message: 'Durable lifecycle state is running but observed runtime is ' + observed.status + '; cannot adopt without convergence',
            previousState: current.phase, operation: 'agent.start',
          });
        }

        // === OPS-008A mismatch resolution: desired=stopped, observed=running ===
        // This handles the mismatch left by OPS-008A manual recovery
        if (current.desired_state === 'stopped' && current.phase === 'stopped' && observed.status === 'running') {
          const requestedAt = nowIso();
          const lifecycle = await updateAgentLifecycleState({
            dir: lifecycleDir, agentId: rawAgentId, now: nowIso,
            patch: {
              desired_state: 'running', phase: 'running',
              previous_desired_state: current.desired_state,
              last_error: null,
              last_operation: {
                operation: 'agent.start',
                actor_id: actor.actor_id, reason,
                requested_at: requestedAt,
                completed_at: nowIso(), outcome: 'accepted',
              },
            },
          });
          const event = await appendAuditEvent({
            dir: auditDir, operation: 'agent.start', actor,
            target: { type: 'agent', id: rawAgentId },
            reason, idempotencyKey,
            previousState: current.phase, resultingState: lifecycle.phase,
            outcome: 'accepted',
            metadata: {
              runtime_adapter: observed.adapter_id || target.runtime_adapter_id,
              lifecycle_controller: target.controller.id,
              observed_state_before: observed.status,
              command_executed: false,
              mismatch_resolution: true,
            },
          });
          return {
            status: 202,
            body: {
              operation: 'agent.start',
              agent: {
                id: rawAgentId,
                desired_state: lifecycle.desired_state,
                lifecycle_state: lifecycle.phase,
                observed_state_before: observed.status,
              },
              command_executed: false,
              audit_event_id: event.event_id,
            },
          };
        }

        // === Fail closed for unsafe observation ===
        if (observed.status === 'unknown' || observed.status === 'unavailable' || observed.status === 'missing') {
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: 'runtime_observation_' + observed.status, status: 409,
            message: 'Cannot start agent because runtime observation is ' + observed.status, previousState: current.phase,
            operation: 'agent.start',
          });
        }

        // === Reject if currently in a transitioning phase ===
        if (current.phase === 'draining' || current.phase === 'stopping' || current.phase === 'starting') {
          return rejected({
            auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
            errorCode: 'lifecycle_operation_active', status: 409,
            message: 'Agent is currently ' + current.phase + '; cannot start until operation completes or fails',
            previousState: current.phase,
            operation: 'agent.start',
          });
        }
        const requestedAt = nowIso();
        const desiredRunning = 'running';
        await updateAgentLifecycleState({
          dir: lifecycleDir,
          agentId: rawAgentId,
          now: nowIso,
          patch: {
            desired_state: desiredRunning,
            phase: 'starting',
            previous_desired_state: current.desired_state,
            last_error: null,
            last_operation: {
              operation: 'agent.start',
              actor_id: actor.actor_id,
              reason,
              requested_at: requestedAt,
              outcome: 'in_progress',
            },
          },
        });

        // Determine if we need to actually start or adopt
        const commandStartable = STARTABLE_RUNTIME_STATES.has(observed.status);
        let commandExecuted = false;
        let controllerResult = { controller_id: target.controller.id, action: 'start' };

        if (commandStartable) {
          commandExecuted = true;
          try {
            controllerResult = await target.controller.start(target.prepared, {
              timeoutSeconds: startTimeoutSeconds,
            });
          } catch {
            await updateAgentLifecycleState({
              dir: lifecycleDir,
              agentId: rawAgentId,
              now: nowIso,
              patch: {
                desired_state: desiredRunning,
                phase: 'failed',
                previous_desired_state: null,
                last_error: 'runtime_start_failed',
                last_operation: {
                  operation: 'agent.start',
                  actor_id: actor.actor_id,
                  reason,
                  requested_at: requestedAt,
                  completed_at: nowIso(),
                  outcome: 'failed',
                },
              },
            });
            return rejected({
              auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
              errorCode: 'runtime_start_failed', status: 502,
              message: 'Agent runtime start failed', previousState: current.phase,
              resultingState: 'failed',
              operation: 'agent.start',
              metadata: {
                runtime_adapter: observed.adapter_id,
                lifecycle_controller: target.controller.id,
              },
            });
          }
        }

        // Check convergence after start
        const startedAt = now();
        let converged = false;
        const convergenceTimeoutMs = Math.max(1000, Number(startTimeoutSeconds) * 1000);
        const convergencePollMs = 500;
        while (now() - startedAt < convergenceTimeoutMs) {
          const postSnapshot = inspectObservedRuntime(getRuntimeSnapshot, rawAgentId, target.runtime_adapter_id || null);
          if (postSnapshot.status === 'running') {
            converged = true;
            break;
          }
          await sleep(Math.min(convergencePollMs, Math.max(1, convergenceTimeoutMs - (now() - startedAt))));
        }

        if (!converged) {
          // Persist durable failed state with audit evidence
          const timeoutCompletedAt = nowIso();
          await updateAgentLifecycleState({
            dir: lifecycleDir, agentId: rawAgentId, now: nowIso,
            patch: {
              desired_state: desiredRunning,
              phase: 'failed',
              previous_desired_state: null,
              last_error: 'runtime_start_convergence_timeout',
              last_operation: {
                operation: 'agent.start',
                actor_id: actor.actor_id, reason,
                requested_at: requestedAt,
                completed_at: timeoutCompletedAt,
                outcome: 'failed',
              },
            },
          });
          const timeoutEvent = await appendAuditEvent({
            dir: auditDir, operation: 'agent.start', actor,
            target: { type: 'agent', id: rawAgentId },
            reason, idempotencyKey,
            previousState: current.phase, resultingState: 'failed',
            outcome: 'failed',
            metadata: {
              runtime_adapter: observed.adapter_id || target.runtime_adapter_id,
              lifecycle_controller: target.controller.id,
              observed_state_before: observed.status,
              command_executed: commandExecuted,
              convergence_timeout_ms: Math.max(1000, Number(startTimeoutSeconds) * 1000),
            },
          });
          return {
            status: 504,
            body: {
              error: 'Agent runtime start timed out waiting for health convergence',
              error_code: 'runtime_start_convergence_timeout',
              audit_event_id: timeoutEvent.event_id,
              agent: {
                id: rawAgentId,
                desired_state: desiredRunning,
                lifecycle_state: 'failed',
              },
              command_executed: commandExecuted,
            },
          };
        }
        const lifecycle = await updateAgentLifecycleState({
          dir: lifecycleDir,
          agentId: rawAgentId,
          now: nowIso,
          patch: {
            desired_state: desiredRunning,
            phase: 'running',
            previous_desired_state: null,
            last_error: null,
            last_operation: {
              operation: 'agent.start',
              actor_id: actor.actor_id,
              reason,
              requested_at: requestedAt,
              completed_at: nowIso(),
              outcome: 'accepted',
            },
          },
        });

        const postConvergence = inspectObservedRuntime(getRuntimeSnapshot, rawAgentId, target.runtime_adapter_id || null);
        const convergence = classifyConvergence(lifecycle.desired_state, lifecycle.phase, postConvergence.status);

        const event = await appendAuditEvent({
          dir: auditDir,
          operation: 'agent.start',
          actor,
          target: { type: 'agent', id: rawAgentId },
          reason,
          idempotencyKey,
          previousState: current.phase,
          resultingState: lifecycle.phase,
          outcome: 'accepted',
          metadata: {
            runtime_adapter: observed.adapter_id || target.runtime_adapter_id,
            lifecycle_controller: controllerResult.controller_id,
            observed_state_before: observed.status,
            command_executed: commandExecuted,
            convergence_status: convergence.status,
            convergence_reason: convergence.reason_code,
          },
        });

        return {
          status: 202,
          body: {
            operation: 'agent.start',
            agent: {
              id: rawAgentId,
              desired_state: lifecycle.desired_state,
              lifecycle_state: lifecycle.phase,
              observed_state_before: observed.status,
            },
            command_executed: commandExecuted,
            convergence,
            audit_event_id: event.event_id,
          },
        };
      })),
    });

    return {
      status: result.response.status,
      body: { ...result.response.body, idempotent_replay: result.replayed },
    };
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
      const current = await readAgentLifecycleState({ dir: lifecycleDir, agentId: rawAgentId });
      return rejected({
        auditDir, actor, agentId: rawAgentId, reason, idempotencyKey,
        errorCode: error.code, status: 409, message: error.message,
        previousState: current.phase,
        operation: 'agent.start',
      });
    }
    throw error;
  }
}
export async function canDispatchAgentFromLifecycle({ lifecycleDir, agentId }) {
  const state = await readAgentLifecycleState({ dir: lifecycleDir, agentId });
  return agentLifecycleAllowsDispatch(state);
}