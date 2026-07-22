import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';

import { loadSkillManifests } from '../../src/services/skill-registry/loader.js';
import { loadMemorySpaceManifests } from '../../src/services/memory-space-registry/loader.js';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SEGMENTS = new Set([
  '.env', 'data', 'secrets', 'node_modules', 'workspaces', 'logs', 'test', 'tests', 'dashboard',
]);
export const REQUIRED_SKILL_MANIFESTS = [
  'architecture-analysis',
  'documentation',
  'failure-analysis',
  'implementation',
  'product-analysis',
  'pull-request-review',
  'regression-testing',
  'risk-analysis',
  'security-review',
  'technical-research',
  'test-authoring',
  'verification',
].map((key) => `config/skills/${key}/1.0.0/manifest.json`);
export const REQUIRED_MEMORY_SPACE_MANIFESTS = [
  'berlin-private',
  'gemini-private',
  'linkup-project',
  'ops-room-archive',
  'ops-room-implementation',
  'ops-room-project',
  'ops-room-research',
  'ops-room-reviews',
  'ops-room-shared',
  'ops-room-verification',
  'professor-private',
  'tokyo-private',
].map((key) => `config/memory-spaces/${key}/1.0.0/manifest.json`);

export function validateReleaseSha(value) {
  const sha = String(value || '').toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error('Release SHA must be exactly 40 hexadecimal characters');
  return sha;
}

export function normalizeArchivePath(value) {
  const normalized = String(value || '').replace(/^\.\//, '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
  return normalized.replace(/\/$/, '');
}

function isAllowedManifestPath(path, rootName) {
  const segments = path.split('/');
  if (path === `config/${rootName}`) return true;
  if (segments[0] !== 'config' || segments[1] !== rootName) return false;
  if (segments.length === 3) return KEY_PATTERN.test(segments[2]);
  if (segments.length === 4) return KEY_PATTERN.test(segments[2]) && SEMVER_PATTERN.test(segments[3]);
  return segments.length === 5 && KEY_PATTERN.test(segments[2]) && SEMVER_PATTERN.test(segments[3]) && segments[4] === 'manifest.json';
}

export function assertAllowedReleasePath(value) {
  const path = normalizeArchivePath(value);
  if (
    path === 'RELEASE.json' || path === 'ops-room' || path === 'ops-room/src' || path === 'ops-room/dist' ||
    path === 'ops-room/dist/dashboard' || path === 'config' || path === 'config/agent-profiles' ||
    isAllowedManifestPath(path, 'skills') || isAllowedManifestPath(path, 'memory-spaces')
  ) {
    return path;
  }
  if (
    path === 'ops-room/package.json' || path.startsWith('ops-room/src/') || path.startsWith('ops-room/dist/dashboard/') ||
    path.startsWith('config/agent-profiles/')
  ) {
    const segments = path.split('/');
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment) && segment !== 'dashboard')) {
      throw new Error(`Forbidden release content: ${path}`);
    }
    if (path.startsWith('config/agent-profiles/') && !path.endsWith('.json')) {
      throw new Error(`Unexpected agent profile content: ${path}`);
    }
    return path;
  }
  throw new Error(`Unexpected release content: ${path}`);
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function archiveEntries(archivePath) {
  const { stdout } = await execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.split(/\r?\n/)
    .filter((line) => line && line !== '.' && line !== './')
    .map(assertAllowedReleasePath);
}

async function assertRegularArchiveEntries(archivePath) {
  const { stdout } = await execFileAsync('tar', ['-tvzf', archivePath], { maxBuffer: 10 * 1024 * 1024 });
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const type = line[0];
    if (type !== '-' && type !== 'd') throw new Error(`Release contains unsupported archive entry type: ${type}`);
  }
}

export async function verifyReleaseArtifact({ archivePath, checksumPath, expectedSha }) {
  const sha = validateReleaseSha(expectedSha);
  const expectedChecksum = (await readFile(checksumPath, 'utf-8')).trim().split(/\s+/)[0];
  const actualChecksum = await sha256File(archivePath);
  if (expectedChecksum !== actualChecksum) throw new Error('Release archive checksum mismatch');

  const entries = await archiveEntries(archivePath);
  await assertRegularArchiveEntries(archivePath);
  for (const required of [
    'RELEASE.json', 'ops-room/package.json', 'ops-room/src/server/webhook.js', 'ops-room/dist/dashboard/index.html',
    'config/agent-profiles/professor.json', 'config/agent-profiles/berlin.json',
    'config/agent-profiles/tokyo.json', 'config/agent-profiles/gemini.json',
    ...REQUIRED_SKILL_MANIFESTS,
    ...REQUIRED_MEMORY_SPACE_MANIFESTS,
  ]) {
    if (!entries.includes(required)) throw new Error(`Release is missing required file: ${required}`);
  }

  const actualSkillManifests = entries.filter((entry) => entry.startsWith('config/skills/') && entry.endsWith('/manifest.json')).sort();
  if (JSON.stringify(actualSkillManifests) !== JSON.stringify([...REQUIRED_SKILL_MANIFESTS].sort())) {
    throw new Error('Release skill manifest set does not match the approved manifest set');
  }
  const actualMemoryManifests = entries.filter((entry) => entry.startsWith('config/memory-spaces/') && entry.endsWith('/manifest.json')).sort();
  if (JSON.stringify(actualMemoryManifests) !== JSON.stringify([...REQUIRED_MEMORY_SPACE_MANIFESTS].sort())) {
    throw new Error('Release memory-space manifest set does not match the approved manifest set');
  }

  const extractDir = await mkdtemp(join(tmpdir(), 'ops-room-release-verify-'));
  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], { maxBuffer: 10 * 1024 * 1024 });
    const manifest = JSON.parse(await readFile(join(extractDir, 'RELEASE.json'), 'utf-8'));
    if (manifest.schema !== 'ops-room.release.v1') throw new Error('Unsupported release manifest schema');
    if (manifest.commit_sha !== sha) throw new Error('Release manifest SHA does not match requested revision');
    return { manifest, checksum: actualChecksum, entries };
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

async function sortedReleaseFiles(root, relative = '') {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await sortedReleaseFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Release staging contains unsupported entry: ${path}`);
  }
  return files;
}

async function normalizeReleaseMetadata(root, relative = '') {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const absolutePath = join(root, path);
    if (entry.isDirectory()) await normalizeReleaseMetadata(root, path);
    await chmod(absolutePath, entry.isDirectory() ? 0o755 : 0o644);
    await utimes(absolutePath, 0, 0);
  }
}

async function writeChecksumOnce(checksumPath, checksum, archivePath) {
  try {
    await writeFile(checksumPath, `${checksum}  ${basename(archivePath)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function copyApprovedSkillManifests(sourceRoot, releaseRoot) {
  const sourceSkills = join(sourceRoot, 'config', 'skills');
  const loaded = await loadSkillManifests(sourceSkills);
  const discovered = loaded.manifests.map((manifest) => `config/skills/${manifest.key}/${manifest.version}/manifest.json`).sort();
  if (JSON.stringify(discovered) !== JSON.stringify([...REQUIRED_SKILL_MANIFESTS].sort())) {
    throw new Error('Source skill manifest set does not match the approved release set');
  }
  for (const manifest of loaded.manifests) {
    const destination = join(releaseRoot, 'config', 'skills', manifest.key, manifest.version);
    await mkdir(destination, { recursive: true });
    await cp(join(sourceSkills, manifest.key, manifest.version, 'manifest.json'), join(destination, 'manifest.json'));
  }
}

async function copyApprovedMemorySpaceManifests(sourceRoot, releaseRoot) {
  const sourceMemorySpaces = join(sourceRoot, 'config', 'memory-spaces');
  const loaded = await loadMemorySpaceManifests(sourceMemorySpaces);
  const discovered = loaded.manifests.map((manifest) => `config/memory-spaces/${manifest.key}/${manifest.version}/manifest.json`).sort();
  if (JSON.stringify(discovered) !== JSON.stringify([...REQUIRED_MEMORY_SPACE_MANIFESTS].sort())) {
    throw new Error('Source memory-space manifest set does not match the approved release set');
  }
  for (const manifest of loaded.manifests) {
    const destination = join(releaseRoot, 'config', 'memory-spaces', manifest.key, manifest.version);
    await mkdir(destination, { recursive: true });
    await cp(join(sourceMemorySpaces, manifest.key, manifest.version, 'manifest.json'), join(destination, 'manifest.json'));
  }
}

export async function buildReleaseArtifact({ sourceRoot, outputDir, commitSha }) {
  const sha = validateReleaseSha(commitSha);
  const root = resolve(sourceRoot);
  const output = resolve(outputDir);
  const staging = await mkdtemp(join(tmpdir(), 'ops-room-release-build-'));
  const releaseRoot = join(staging, 'release-root');
  const releaseOpsRoom = join(releaseRoot, 'ops-room');
  const archivePath = join(output, `ops-room-${sha}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;

  try {
    await mkdir(join(releaseOpsRoom, 'dist'), { recursive: true });
    await cp(join(root, 'src'), join(releaseOpsRoom, 'src'), { recursive: true });
    await cp(join(root, 'dist', 'dashboard'), join(releaseOpsRoom, 'dist', 'dashboard'), { recursive: true });
    await cp(join(root, 'package.json'), join(releaseOpsRoom, 'package.json'));
    await cp(join(root, 'config', 'agent-profiles'), join(releaseRoot, 'config', 'agent-profiles'), { recursive: true });
    await copyApprovedSkillManifests(root, releaseRoot);
    await copyApprovedMemorySpaceManifests(root, releaseRoot);
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'));
    await writeFile(join(releaseRoot, 'RELEASE.json'), `${JSON.stringify({
      schema: 'ops-room.release.v1',
      repository: 'LihSheng/ops-room',
      commit_sha: sha,
      package_version: packageJson.version,
      node_engine: packageJson.engines?.node || null,
    }, null, 2)}\n`);
    await normalizeReleaseMetadata(releaseRoot);

    await mkdir(output, { recursive: true });
    const fileList = join(staging, 'release-files.txt');
    await writeFile(fileList, `${(await sortedReleaseFiles(releaseRoot)).join('\n')}\n`);
    const temporaryArchive = join(output, `.ops-room-${sha}.${process.pid}.${Date.now()}.tmp.tar.gz`);
    const temporaryTar = join(staging, 'release.tar');
    await execFileAsync('tar', [
      '--format', 'ustar',
      '-cf', temporaryTar, '-C', releaseRoot, '-T', fileList,
    ], { maxBuffer: 10 * 1024 * 1024 });
    await pipeline(
      createReadStream(temporaryTar),
      createGzip({ level: 9, mtime: 0 }),
      createWriteStream(temporaryArchive, { flags: 'wx' }),
    );
    try {
      await link(temporaryArchive, archivePath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporaryArchive).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    const checksum = await sha256File(archivePath);
    await writeChecksumOnce(checksumPath, checksum, archivePath);
    await verifyReleaseArtifact({ archivePath, checksumPath, expectedSha: sha });
    return { archivePath, checksumPath, checksum };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
