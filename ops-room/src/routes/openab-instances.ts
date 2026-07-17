import { getOpenABInstances } from '../services/openab-instances.js';

export async function handleOpenABInstances() {
  return getOpenABInstances();
}
