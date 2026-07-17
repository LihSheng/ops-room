import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDirectory = join(root, 'test');
const testFiles = (await readdir(testDirectory))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(testDirectory, name));

if (testFiles.length === 0) throw new Error('No test files found');

const child = spawn(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
child.once('error', (error) => { throw error; });
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
