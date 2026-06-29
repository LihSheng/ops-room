import { getOpenABInstances } from '../services/openab-instances.mjs';

export async function handleOpenABInstances() {
  return getOpenABInstances();
}
