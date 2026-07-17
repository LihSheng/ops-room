#!/usr/bin/env node
import { resolve } from 'node:path';

import { verifyReleaseArtifact } from './release-artifact.mjs';

const archivePath = resolve(process.argv[2] || '');
const expectedSha = process.argv[3];
const checksumPath = resolve(process.argv[4] || `${archivePath}.sha256`);

const result = await verifyReleaseArtifact({ archivePath, checksumPath, expectedSha });
console.log(JSON.stringify(result));
