import { appendFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import {
  OPERATOR_API_ENABLED, OPERATOR_TOKEN, SHARED_MEMORY, WEBHOOK_SECRET,
} from '../services/runtime-paths.mjs';

export async function appendToMemory(entry) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
    await appendFile(SHARED_MEMORY, `- ${ts}: [GitHub Issue] ${entry}\n`);
  } catch { }
}

export function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function verifyBearer(authHeader, expectedToken) {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !expectedToken) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function verifyAuth(authHeader) {
  return verifyBearer(authHeader, WEBHOOK_SECRET);
}

export function verifyOperatorAuth(authHeader) {
  return OPERATOR_API_ENABLED && verifyBearer(authHeader, OPERATOR_TOKEN);
}

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
