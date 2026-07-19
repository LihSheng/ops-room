import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { MemorySpaceValidationError, normalizePublicationPath, validateMemorySpaceManifest } from './schema.js';
import type { MemorySpaceManifest } from './schema.js';

export type LoadedMemorySpaceManifests = {
  manifests: MemorySpaceManifest[];
  sources: Record<string, string>;
};

export function memorySpaceManifestId(key: string, version: string) {
  return `${key}@${version}`;
}

function isInsideRoot(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function isNestedPath(parent: string, child: string) {
  return child.startsWith(`${parent}/`);
}

function validateRelationships(manifests: MemorySpaceManifest[], issues: string[]) {
  const byKey = new Map<string, MemorySpaceManifest>();
  for (const manifest of manifests) {
    const previous = byKey.get(manifest.key);
    if (previous) {
      issues.push(`${manifest.key}: only one active memory-space version is allowed; found ${previous.version} and ${manifest.version}`);
      continue;
    }
    byKey.set(manifest.key, manifest);
  }

  for (const manifest of manifests) {
    if (!manifest.parentKey) continue;
    const parent = byKey.get(manifest.parentKey);
    if (!parent) {
      issues.push(`${manifest.key}: parentKey ${manifest.parentKey} does not resolve`);
      continue;
    }
    if (!isNestedPath(normalizePublicationPath(parent.publicationPath), normalizePublicationPath(manifest.publicationPath))) {
      issues.push(`${manifest.key}: publicationPath must be nested under parent ${manifest.parentKey}`);
    }
  }

  for (let leftIndex = 0; leftIndex < manifests.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < manifests.length; rightIndex += 1) {
      const left = manifests[leftIndex];
      const right = manifests[rightIndex];
      const leftPath = normalizePublicationPath(left.publicationPath);
      const rightPath = normalizePublicationPath(right.publicationPath);
      if (leftPath === rightPath) {
        issues.push(`${left.key} and ${right.key}: duplicate publicationPath ${leftPath}`);
        continue;
      }
      if (isNestedPath(leftPath, rightPath) && right.parentKey !== left.key) {
        issues.push(`${right.key}: overlapping publicationPath must declare parentKey ${left.key}`);
      }
      if (isNestedPath(rightPath, leftPath) && left.parentKey !== right.key) {
        issues.push(`${left.key}: overlapping publicationPath must declare parentKey ${right.key}`);
      }
    }
  }
}

export async function loadMemorySpaceManifests(dir: string): Promise<LoadedMemorySpaceManifests> {
  const issues: string[] = [];
  const manifests: MemorySpaceManifest[] = [];
  const sources: Record<string, string> = {};
  const seen = new Map<string, string>();

  const rootStat = await lstat(dir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new MemorySpaceValidationError([`${dir}: approved memory-space root must be a real directory`]);
  }
  const root = await realpath(dir);
  const spaceEntries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));

  for (const spaceEntry of spaceEntries) {
    const spacePath = join(dir, spaceEntry.name);
    if (spaceEntry.isSymbolicLink()) {
      issues.push(`${spaceEntry.name}: symlink entries are not allowed`);
      continue;
    }
    if (!spaceEntry.isDirectory()) {
      issues.push(`${spaceEntry.name}: unexpected entry in approved memory-space root`);
      continue;
    }
    const spaceReal = await realpath(spacePath).catch(() => '');
    if (!spaceReal || !isInsideRoot(root, spaceReal)) {
      issues.push(`${spaceEntry.name}: memory-space directory escapes the approved root`);
      continue;
    }

    const versionEntries = (await readdir(spacePath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const versionEntry of versionEntries) {
      const versionPath = join(spacePath, versionEntry.name);
      const source = `${spaceEntry.name}/${versionEntry.name}/manifest.json`;
      if (versionEntry.isSymbolicLink()) {
        issues.push(`${spaceEntry.name}/${versionEntry.name}: symlink entries are not allowed`);
        continue;
      }
      if (!versionEntry.isDirectory()) {
        issues.push(`${spaceEntry.name}/${versionEntry.name}: expected a version directory`);
        continue;
      }
      const versionReal = await realpath(versionPath).catch(() => '');
      if (!versionReal || !isInsideRoot(root, versionReal)) {
        issues.push(`${spaceEntry.name}/${versionEntry.name}: version directory escapes the approved root`);
        continue;
      }

      const files = (await readdir(versionPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const manifestEntry = files.find((entry) => entry.name === 'manifest.json');
      for (const file of files) {
        if (file.name !== 'manifest.json' || !file.isFile() || file.isSymbolicLink()) {
          issues.push(`${spaceEntry.name}/${versionEntry.name}/${file.name}: only a regular manifest.json is allowed`);
        }
      }
      if (!manifestEntry || !manifestEntry.isFile() || manifestEntry.isSymbolicLink()) {
        issues.push(`${source}: manifest file is required`);
        continue;
      }

      const manifestPath = join(versionPath, 'manifest.json');
      const manifestReal = await realpath(manifestPath).catch(() => '');
      if (!manifestReal || !isInsideRoot(root, manifestReal)) {
        issues.push(`${source}: manifest escapes the approved root`);
        continue;
      }

      try {
        const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
        const manifest = validateMemorySpaceManifest(parsed, source);
        if (manifest.key !== spaceEntry.name) issues.push(`${source}: directory key must match manifest key ${manifest.key}`);
        if (manifest.version !== versionEntry.name) issues.push(`${source}: directory version must match manifest version ${manifest.version}`);
        const id = memorySpaceManifestId(manifest.key, manifest.version);
        const previous = seen.get(id);
        if (previous) issues.push(`${source}: duplicate key/version pair also declared by ${previous}`);
        else {
          seen.set(id, source);
          manifests.push(manifest);
          sources[id] = manifestPath;
        }
      } catch (error) {
        if (error instanceof SyntaxError) issues.push(`${source}: malformed JSON`);
        else if (error instanceof MemorySpaceValidationError) issues.push(...error.issues);
        else issues.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (manifests.length === 0) issues.push(`${dir}: no valid memory-space manifests found`);
  validateRelationships(manifests, issues);
  if (issues.length) throw new MemorySpaceValidationError(issues);
  manifests.sort((left, right) => left.key.localeCompare(right.key) || left.version.localeCompare(right.version));
  return { manifests, sources };
}
