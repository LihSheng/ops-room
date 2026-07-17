import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const FORBIDDEN_SEGMENTS = new Set([
  '.env', 'data', 'secrets', 'node_modules', 'workspaces', 'logs', 'test', 'tests', 'dashboard',
]);

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

export function assertAllowedReleasePath(value) {
  const path = normalizeArchivePath(value);
  if (path === 'RELEASE.json' || path === 'ops-room' || path === 'ops-room/src' || path === 'ops-room/dist' || path === 'ops-room/dist/dashboard') {
    return path;
  }
  if (path === 'ops-room/package.json' || path.startsWith('ops-room/src/') || path.startsWith('ops-room/dist/dashboard/')) {
    const segments = path.split('/');
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment) && !['dashboard'].includes(segment))) {
      throw new Error(`Forbidden release content: ${path}`);
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
  for (const required of ['RELEASE.json', 'ops-room/package.json', 'ops-room/src/server/webhook.mjs', 'ops-room/dist/dashboard/index.html']) {
    if (!entries.includes(required)) throw new Error(`Release is missing required file: ${required}`);
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
