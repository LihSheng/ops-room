import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { reconcileInterruptedMissionChatTurns } from './mission-chat-store.js';

export async function reconcileMissionChatOnStartup({
  dir,
  reconcile = reconcileInterruptedMissionChatTurns,
}: any) {
  if (!dir) throw new Error('mission_chat_recovery_dir_required');
  await rm(join(dir, '.locks'), { recursive: true, force: true });
  return reconcile({ dir });
}
