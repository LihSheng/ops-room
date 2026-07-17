#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { buildReleaseArtifact } from './release-artifact.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDir, '..', '..');
const commitSha = process.argv[2] || process.env.OPS_ROOM_RELEASE_SHA || process.env.GITHUB_SHA;
const outputDir = resolve(process.argv[3] || process.env.OPS_ROOM_RELEASE_OUTPUT || resolve(sourceRoot, '..', 'release-artifacts'));

const result = await buildReleaseArtifact({ sourceRoot, outputDir, commitSha });
console.log(JSON.stringify(result));
