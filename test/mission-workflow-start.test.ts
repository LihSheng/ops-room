import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMission, readMission } from '../src/services/mission-store.js';
import { startMissionWorkflow } from '../src/services/mission-workflow-start.js';
import {
  createOrLoadWorkflowRun,
  ensureWorkflowChild,
  listWorkflowRuns,
} from '../src/services/workflow-run-store.js';

const SHA_A = 'a'.repeat(40);
const ACTOR = Object.freeze({
  actor_id: 'operator-1',
  actor_display_name: 'Operator One',
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-mission-start-'));
  const missionsDir = join(root, 'missions');
  const workflowRunsDir = join(root, 'workflow-runs');
  const created = await createMission({
    dir: missionsDir,
    input: {
      title: 'Start mission workflow',
      objective: 'Verify deterministic mission-to-workflow binding.',
      repository: 'LihSheng/ops-room',
      starting_branch: 'main',
      starting_sha: SHA_A,
      workflow_type: 'feature-development',
      max_iterations: 3,
      approval_policy: 'berlin-review-required',
      priority: 'normal',
    },
    actor: ACTOR,
    requestKey: 'mission-create-start-test',
  });
  return { root, missionsDir, workflowRunsDir, mission: created.mission };
}

test('starting a planned mission creates one workflow and one pending Professor child', async () => {
  const setup = await fixture();
  const result = await startMissionWorkflow({
    missionsDir: setup.missionsDir,
    workflowRunsDir: setup.workflowRunsDir,
    missionId: setup.mission.mission_id,
    actor: ACTOR,
  });

  assert.equal(result.started, true);
  assert.equal(result.workflow_created, true);
  assert.equal(result.child_created, true);
  assert.equal(result.mission.state, 'active');
  assert.equal(result.mission.workflow_id, result.workflow.workflow_id);
  assert.equal(result.workflow.state, 'active');
  assert.equal(result.workflow.child_count, 1);
  assert.equal(result.initial_child, undefined);
  assert.equal(result.child.stage, 'implementation');
  assert.equal(result.child.owner_agent, 'professor');
  assert.equal(result.child.iteration, 1);
  assert.equal(result.child.state, 'pending');
  assert.equal(result.child.input_sha, SHA_A);
  assert.equal(result.child.depends_on, null);

  const persistedMission = await readMission({
    dir: setup.missionsDir,
    missionId: setup.mission.mission_id,
  });
  assert.equal(persistedMission.state, 'active');
  assert.equal(persistedMission.workflow_id, result.workflow.workflow_id);
});

test('repeated and concurrent starts converge on one workflow and child', async () => {
  const setup = await fixture();
  const [left, right] = await Promise.all([
    startMissionWorkflow({
      missionsDir: setup.missionsDir,
      workflowRunsDir: setup.workflowRunsDir,
      missionId: setup.mission.mission_id,
      actor: ACTOR,
    }),
    startMissionWorkflow({
      missionsDir: setup.missionsDir,
      workflowRunsDir: setup.workflowRunsDir,
      missionId: setup.mission.mission_id,
      actor: ACTOR,
    }),
  ]);

  assert.equal(left.workflow.workflow_id, right.workflow.workflow_id);
  assert.equal(left.child.child_id, right.child.child_id);
  assert.equal([left.started, right.started].filter(Boolean).length, 1);

  const workflows = await listWorkflowRuns({ dir: setup.workflowRunsDir });
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].children.length, 1);

  const replay = await startMissionWorkflow({
    missionsDir: setup.missionsDir,
    workflowRunsDir: setup.workflowRunsDir,
    missionId: setup.mission.mission_id,
    actor: ACTOR,
  });
  assert.equal(replay.started, false);
  assert.equal(replay.workflow_created, false);
  assert.equal(replay.child_created, false);
});

test('a partial workflow and child created before mission binding are recovered safely', async () => {
  const setup = await fixture();
  const requestKey = `mission-start:${setup.mission.mission_id}:v1`;
  const workflow = await createOrLoadWorkflowRun({
    dir: setup.workflowRunsDir,
    input: {
      repository: setup.mission.repository_id,
      requestKey,
      sourceSha: setup.mission.starting_sha,
    },
    policy: { max_iterations: 3, max_concurrency: 1 },
  });
  const child = await ensureWorkflowChild({
    dir: setup.workflowRunsDir,
    workflowId: workflow.run.workflow_id,
    iteration: 1,
    stage: 'implementation',
    inputSha: setup.mission.starting_sha,
  });

  const result = await startMissionWorkflow({
    missionsDir: setup.missionsDir,
    workflowRunsDir: setup.workflowRunsDir,
    missionId: setup.mission.mission_id,
    actor: ACTOR,
  });

  assert.equal(result.started, true);
  assert.equal(result.workflow_created, false);
  assert.equal(result.child_created, false);
  assert.equal(result.workflow.workflow_id, workflow.run.workflow_id);
  assert.equal(result.child.child_id, child.child.child_id);
});

test('an active mission with missing workflow authority fails closed', async () => {
  const setup = await fixture();
  await startMissionWorkflow({
    missionsDir: setup.missionsDir,
    workflowRunsDir: setup.workflowRunsDir,
    missionId: setup.mission.mission_id,
    actor: ACTOR,
  });

  for (const name of await readdir(setup.workflowRunsDir)) {
    if (name.endsWith('.json')) await rm(join(setup.workflowRunsDir, name));
  }

  await assert.rejects(
    startMissionWorkflow({
      missionsDir: setup.missionsDir,
      workflowRunsDir: setup.workflowRunsDir,
      missionId: setup.mission.mission_id,
      actor: ACTOR,
    }),
    /mission_bound_workflow_unavailable/,
  );
});
