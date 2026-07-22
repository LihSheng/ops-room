import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OPS_ROOM_ROOT } from './runtime-paths.js';

const RELEASE_SHA_PATTERN = /^[a-f0-9]{40}$/;

export async function readReleaseInfo({
  manifestPath = join(OPS_ROOM_ROOT, '..', 'RELEASE.json'),
  env = process.env,
  readFileFn = readFile,
} = {}) {
  try {
    const manifest = JSON.parse(await readFileFn(manifestPath, 'utf8'));
    if (manifest.schema !== 'ops-room.release.v1') {
      throw new Error('Unsupported release manifest schema');
    }
    if (!RELEASE_SHA_PATTERN.test(manifest.commit_sha || '')) {
      throw new Error('Release manifest commit_sha must be 40 lowercase hexadecimal characters');
    }
    return { ...manifest, source: 'manifest' };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const revision = env.OPS_ROOM_RELEASE_SHA || env.GITHUB_SHA || 'development';
  return { commit_sha: revision, source: revision === 'development' ? 'development' : 'environment' };
}
