import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  readMission,
  serializeMission,
  validateMissionRecord,
  type MissionRecord,
} from './mission-store.js';
import { writeAtomic } from './review-task-store.js';
import {
  buildWorkflowRunId,
  createOrLoadWorkflowRun,
  ensureWorkflowChild,
  readWorkflowRun,
  serializeWorkflowRun,
} from './workflow-run-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const START_LOCK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function missionFilename(missionId: string): string {
  if (!SAFE_ID.test(missionId)) throw new Error('invalid_mission_id');
  return `mission-${createHash('sha256').update(missionId).digest('hex')}.json`;
}

function missionPath(dir: string, missionId: string): string {
  return join(dir, missionFilename(missionId));
}

function workflowRequestKey(missionId: string): string {
  if (!SAFE_ID.test(missionId)) throw new Error('invalid_mission_id');
  return `mission-start:${missionId}:v1`;
}

function lockName(missionId: string): string {
  return `mission-start-${createHash('sha256').update(missionId).digest('hex').slice(0, 40)}`;
}

function actorId(actor: any): string {
  const value = String(actor?.actor_id || '').trim();
  if (!SAFE_ID.test(value)) throw new Error('invalid_mission_start_actor');
  return value;
}

function assertWorkflowMatchesMission(mission: MissionRecord, run: any): void {
  if (run.repository_id !== mission.repository_id) throw new Error('mission_workflow_repository_mismatch');
  if (run.source_sha !== mission.starting_sha) throw new Error('mission_workflow_source_sha_mismatch');
  if (run.workflow_type !== mission.workflow_type) throw new Error('mission_workflow_type_mismatch');
  if (run.policy?.max_iterations !== mission.policy.max_iterations) {
    throw new Error('mission_workflow_iteration_policy_mismatch');
  }
  if (run.policy?.max_concurrency !== 1) throw new Error('mission_workflow_concurrency_policy_mismatch');
}

function assertImplementationChild(mission: MissionRecord, run: any, child: any): void {
  if (!child) throw new Error('mission_workflow_initial_child_unavailable');
  if (child.stage !== 'implementation') throw new Error('mission_workflow_initial_child_stage_mismatch');
  if (child.owner_agent !== 'professor') throw new Error('mission_workflow_initial_child_owner_mismatch');
  if (child.iteration !== 1) throw new Error('mission_workflow_initial_child_iteration_mismatch');
  if (child.depends_on !== null) throw new Error('mission_workflow_initial_child_dependency_mismatch');
  if (child.input_sha !== mission.starting_sha) throw new Error('mission_workflow_initial_child_sha_mismatch');
  if (!run.children.some((candidate: any) => candidate.child_id === child.child_id)) {
    throw new Error('mission_workflow_initial_child_not_persisted');
  }
}

async function bindMissionWorkflow({
  missionsDir,
  missionId,
  workflowId,
  actor,
  now,
}: {
  missionsDir: string;
  missionId: string;
  workflowId: string;
  actor: any;
  now: () => string;
}) {
  const mission = await readMission({ dir: missionsDir, missionId });
  if (mission.workflow_id !== null) {
    if (mission.workflow_id !== workflowId) throw new Error('mission_workflow_binding_conflict');
    if (mission.state !== 'active') throw new Error('mission_workflow_state_conflict');
    return { bound: false, mission };
  }
  if (mission.state !== 'planned') throw new Error(`mission_not_startable:${mission.state}`);

  const at = now();
  const updated = validateMissionRecord({
    ...mission,
    state: 'active',
    workflow_id: workflowId,
    updated_at: at,
    last_error: null,
    history: [
      ...mission.history,
      {
        event: 'mission_workflow_bound',
        workflow_id: workflowId,
        actor_id: actorId(actor),
        at,
      },
    ],
  });
  await writeAtomic(missionPath(missionsDir, missionId), updated);
  return { bound: true, mission: updated };
}

export async function startMissionWorkflow({
  missionsDir,
  workflowRunsDir,
  missionId,
  actor,
  lockDir = join(missionsDir, '.workflow-start-locks'),
  lockTimeoutMs = 10_000,
  lockStaleAfterMs = START_LOCK_STALE_AFTER_MS,
  now = () => new Date().toISOString(),
}: {
  missionsDir: string;
  workflowRunsDir: string;
  missionId: string;
  actor: any;
  lockDir?: string;
  lockTimeoutMs?: number;
  lockStaleAfterMs?: number;
  now?: () => string;
}) {
  if (!SAFE_ID.test(String(missionId || ''))) throw new Error('invalid_mission_id');

  return withWorkspaceLock({
    dir: lockDir,
    name: lockName(missionId),
    timeoutMs: lockTimeoutMs,
    staleAfterMs: lockStaleAfterMs,
    execute: async () => {
      const mission = await readMission({ dir: missionsDir, missionId });
      const requestKey = workflowRequestKey(mission.mission_id);
      const expectedWorkflowId = buildWorkflowRunId({
        repository: mission.repository_id,
        requestKey,
      });

      if (mission.state === 'active') {
        if (!mission.workflow_id) throw new Error('mission_active_workflow_binding_missing');
        if (mission.workflow_id !== expectedWorkflowId) throw new Error('mission_workflow_binding_conflict');
        let run: any;
        try {
          run = await readWorkflowRun({ dir: workflowRunsDir, workflowId: mission.workflow_id });
        } catch (error: any) {
          if (error?.code === 'ENOENT') throw new Error('mission_bound_workflow_unavailable');
          throw error;
        }
        assertWorkflowMatchesMission(mission, run);
        const child = run.children.find((candidate: any) => (
          candidate.iteration === 1 && candidate.stage === 'implementation'
        ));
        assertImplementationChild(mission, run, child);
        return {
          started: false,
          workflow_created: false,
          child_created: false,
          mission: serializeMission(mission),
          workflow: serializeWorkflowRun(run),
          child,
        };
      }

      if (mission.state !== 'planned') throw new Error(`mission_not_startable:${mission.state}`);
      if (mission.workflow_id !== null) throw new Error('mission_workflow_binding_conflict');

      const workflow = await createOrLoadWorkflowRun({
        dir: workflowRunsDir,
        input: {
          repository: mission.repository_id,
          requestKey,
          sourceSha: mission.starting_sha,
        },
        policy: {
          max_iterations: mission.policy.max_iterations,
          max_concurrency: 1,
        },
        now,
      });
      if (workflow.run.workflow_id !== expectedWorkflowId) throw new Error('mission_workflow_id_mismatch');
      assertWorkflowMatchesMission(mission, workflow.run);

      const implementation = await ensureWorkflowChild({
        dir: workflowRunsDir,
        workflowId: workflow.run.workflow_id,
        iteration: 1,
        stage: 'implementation',
        inputSha: mission.starting_sha,
        now,
      });
      assertImplementationChild(mission, implementation.run, implementation.child);

      const binding = await bindMissionWorkflow({
        missionsDir,
        missionId: mission.mission_id,
        workflowId: workflow.run.workflow_id,
        actor,
        now,
      });

      const persistedRun = await readWorkflowRun({
        dir: workflowRunsDir,
        workflowId: workflow.run.workflow_id,
      });
      assertWorkflowMatchesMission(binding.mission, persistedRun);
      const persistedChild = persistedRun.children.find((candidate: any) => (
        candidate.iteration === 1 && candidate.stage === 'implementation'
      ));
      assertImplementationChild(binding.mission, persistedRun, persistedChild);

      return {
        started: binding.bound,
        workflow_created: workflow.created,
        child_created: implementation.created,
        mission: serializeMission(binding.mission),
        workflow: serializeWorkflowRun(persistedRun),
        child: persistedChild,
      };
    },
  });
}
