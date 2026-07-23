import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { reconcileInterruptedAgentChatTurns } from './agent-chat-store.js';

export async function reconcileAgentChatOnStartup({
  dir,
  reconcile = reconcileInterruptedAgentChatTurns,
}: any) {
  if (!dir) throw new Error('agent_chat_recovery_dir_required');

  // The HTTP server is not accepting chat requests yet. Any lock file present
  // here belongs to a previous process and must not prevent pending-turn
  // reconciliation after a crash.
  await rm(join(dir, '.locks'), { recursive: true, force: true });
  return reconcile({ dir });
}
