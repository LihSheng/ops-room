import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  authorizeOperatorRequest,
  deriveOperatorCsrfToken,
  OPERATOR_CONFIRMATION_HEADER_NAME,
  OPERATOR_CSRF_HEADER_NAME,
  operatorStepUpConfirmationValue,
  requiresOperatorStepUp,
} from '../src/services/operator-request-auth.js';
import { createOperatorSession } from '../src/services/operator-session-store.js';

const ACTOR = Object.freeze({
  actor_type: 'human_operator',
  actor_id: 'operator-1',
  actor_display_name: 'Operator One',
  auth_method: 'operator_token',
});

async function sessionFixture(roles: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-mission-start-auth-'));
  const sessionDir = join(root, 'sessions');
  const auditDir = join(root, 'audit');
  const token = 'm'.repeat(43);
  await createOperatorSession({
    dir: sessionDir,
    actor: ACTOR,
    roles,
    ttlSeconds: 3600,
    generateToken: () => token,
    now: () => '2026-07-23T00:00:00.000Z',
  });
  return { sessionDir, auditDir, token };
}

test('mission start requires exact session CSRF and action-bound confirmation', async () => {
  const fixture = await sessionFixture(['operator']);
  const path = '/api/operator/missions/mission:test:123/start';
  const csrf = deriveOperatorCsrfToken(fixture.token);

  const missingConfirmation = await authorizeOperatorRequest({
    req: {
      method: 'POST',
      url: path,
      headers: {
        cookie: `ops_room_session=${fixture.token}`,
        [OPERATOR_CSRF_HEADER_NAME]: csrf,
      },
    },
    permission: 'mission.start',
    operatorApiEnabled: true,
    humanAuthEnabled: true,
    emergencyReadOnlyEnabled: false,
    sessionDir: fixture.sessionDir,
    auditDir: fixture.auditDir,
    verifyOperatorBearer: () => false,
    now: () => '2026-07-23T00:10:00.000Z',
  });
  assert.equal(missingConfirmation.ok, false);
  if (missingConfirmation.ok) return;
  assert.equal(missingConfirmation.error_code, 'operator_step_up_required');

  const confirmation = operatorStepUpConfirmationValue({
    permission: 'mission.start',
    method: 'POST',
    path,
  });
  const accepted = await authorizeOperatorRequest({
    req: {
      method: 'POST',
      url: path,
      headers: {
        cookie: `ops_room_session=${fixture.token}`,
        [OPERATOR_CSRF_HEADER_NAME]: csrf,
        [OPERATOR_CONFIRMATION_HEADER_NAME]: confirmation,
      },
    },
    permission: 'mission.start',
    operatorApiEnabled: true,
    humanAuthEnabled: true,
    emergencyReadOnlyEnabled: false,
    sessionDir: fixture.sessionDir,
    auditDir: fixture.auditDir,
    verifyOperatorBearer: () => false,
    now: () => '2026-07-23T00:10:00.000Z',
  });
  assert.equal(accepted.ok, true);
  assert.equal(requiresOperatorStepUp('mission.start'), true);
});

test('viewer sessions cannot start a mission even with valid request evidence', async () => {
  const fixture = await sessionFixture(['viewer']);
  const path = '/api/operator/missions/mission:test:123/start';
  const result = await authorizeOperatorRequest({
    req: {
      method: 'POST',
      url: path,
      headers: {
        cookie: `ops_room_session=${fixture.token}`,
        [OPERATOR_CSRF_HEADER_NAME]: deriveOperatorCsrfToken(fixture.token),
        [OPERATOR_CONFIRMATION_HEADER_NAME]: operatorStepUpConfirmationValue({
          permission: 'mission.start',
          method: 'POST',
          path,
        }),
      },
    },
    permission: 'mission.start',
    operatorApiEnabled: true,
    humanAuthEnabled: true,
    emergencyReadOnlyEnabled: false,
    sessionDir: fixture.sessionDir,
    auditDir: fixture.auditDir,
    verifyOperatorBearer: () => false,
    now: () => '2026-07-23T00:10:00.000Z',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error_code, 'operator_permission_denied');
});
