import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { SkillManifestValidationError, validateSkillManifest } from './schema.js';
import type { SkillManifest } from './schema.js';

export type LoadedSkillManifests = {
  manifests: SkillManifest[];
  sources: Record<string, string>;
};

function manifestId(key: string, version: string) {
  return `${key}@${version}`;
}

function isInsideRoot(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export async function loadSkillManifests(dir: string): Promise<LoadedSkillManifests> {
  const issues: string[] = [];
  const manifests: SkillManifest[] = [];
  const sources: Record<string, string> = {};
  const seen = new Map<string, string>();

  const rootStat = await lstat(dir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SkillManifestValidationError([`${dir}: approved skill root must be a real directory`]);
  }
  const root = await realpath(dir);
  const skillEntries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));

  for (const skillEntry of skillEntries) {
    const skillPath = join(dir, skillEntry.name);
    if (skillEntry.isSymbolicLink()) {
      issues.push(`${skillEntry.name}: symlink entries are not allowed`);
      continue;
    }
    if (!skillEntry.isDirectory()) {
      issues.push(`${skillEntry.name}: unexpected entry in approved skill root`);
      continue;
    }
    const skillReal = await realpath(skillPath).catch(() => '');
    if (!skillReal || !isInsideRoot(root, skillReal)) {
      issues.push(`${skillEntry.name}: skill directory escapes the approved root`);
      continue;
    }

    const versionEntries = (await readdir(skillPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const versionEntry of versionEntries) {
      const versionPath = join(skillPath, versionEntry.name);
      const source = `${skillEntry.name}/${versionEntry.name}/manifest.json`;
      if (versionEntry.isSymbolicLink()) {
        issues.push(`${skillEntry.name}/${versionEntry.name}: symlink entries are not allowed`);
        continue;
      }
      if (!versionEntry.isDirectory()) {
        issues.push(`${skillEntry.name}/${versionEntry.name}: expected a version directory`);
        continue;
      }
      const versionReal = await realpath(versionPath).catch(() => '');
      if (!versionReal || !isInsideRoot(root, versionReal)) {
        issues.push(`${skillEntry.name}/${versionEntry.name}: version directory escapes the approved root`);
        continue;
      }

      const files = (await readdir(versionPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const manifestEntry = files.find((entry) => entry.name === 'manifest.json');
      for (const file of files) {
        if (file.name !== 'manifest.json' || !file.isFile() || file.isSymbolicLink()) {
          issues.push(`${skillEntry.name}/${versionEntry.name}/${file.name}: only a regular manifest.json is allowed`);
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
        const manifest = validateSkillManifest(parsed, source);
        if (manifest.key !== skillEntry.name) issues.push(`${source}: directory key must match manifest key ${manifest.key}`);
        if (manifest.version !== versionEntry.name) issues.push(`${source}: directory version must match manifest version ${manifest.version}`);
        const id = manifestId(manifest.key, manifest.version);
        const previous = seen.get(id);
        if (previous) issues.push(`${source}: duplicate key/version pair also declared by ${previous}`);
        else {
          seen.set(id, source);
          manifests.push(manifest);
          sources[id] = manifestPath;
        }
      } catch (error) {
        if (error instanceof SyntaxError) issues.push(`${source}: malformed JSON`);
        else if (error instanceof SkillManifestValidationError) issues.push(...error.issues);
        else issues.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (manifests.length === 0) issues.push(`${dir}: no valid skill manifests found`);
  if (issues.length) throw new SkillManifestValidationError(issues);
  manifests.sort((left, right) => left.key.localeCompare(right.key) || left.version.localeCompare(right.version));
  return { manifests, sources };
}
