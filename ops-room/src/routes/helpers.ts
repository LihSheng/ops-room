import { appendFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import {
  DASHBOARD_TOKEN,
  HUMAN_AUTH_ENABLED,
  OPERATOR_API_ENABLED,
  OPERATOR_TOKEN,
  SHARED_MEMORY,
  WEBHOOK_SECRET,
} from '../services/runtime-paths.js';

const DASHBOARD_READ_ROUTES = [
  /^\/api\/health$/,
  /^\/api\/tasks(?:\/|$)/,
  /^\/api\/logs$/,
  /^\/api\/agents$/,
  /^\/api\/openab\/instances$/,
  /^\/api\/agents\/profiles(?:\/|$)/,
  /^\/api\/skills(?:\/|$)/,
  /^\/api\/memory-spaces(?:\/|$)/,
  /^\/api\/workflows(?:\/|$)/,
  /^\/api\/review-tasks(?:\/|$)/,
];

export async function appendToMemory(entry) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
    await appendFile(SHARED_MEMORY, `- ${ts}: [GitHub Issue] ${entry}\n`);
  } catch { }
}

function requestPath(req) {
  try {
    return new URL(req?.url || '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function requiresDashboardAuth(req) {
  if (req?.method !== 'GET') return false;
  const pathname = requestPath(req);
  return DASHBOARD_READ_ROUTES.some((pattern) => pattern.test(pathname));
}

export function verifyDashboardReadRequest(req) {
  return requiresDashboardAuth(req) && verifyDashboardAuth(req?.headers?.authorization);
}

export function sendJSON(res, status, data, additionalHeaders = {}) {
  if (requiresDashboardAuth(res.req) && !verifyDashboardAuth(res.req?.headers?.authorization)) {
    status = 401;
    data = { error: 'Unauthorized' };
  }

  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...additionalHeaders,
  });
  res.end(JSON.stringify(data));
}

function verifyBearer(authHeader, expectedToken) {
  const normalizedHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!normalizedHeader) return false;
  const match = normalizedHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !expectedToken) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function verifyAuth(authHeader) {
  return verifyBearer(authHeader, WEBHOOK_SECRET);
}

export function verifyDashboardAuth(authHeader) {
  return verifyBearer(authHeader, DASHBOARD_TOKEN);
}

export function verifyOperatorAuth(authHeader) {
  return OPERATOR_API_ENABLED && verifyBearer(authHeader, OPERATOR_TOKEN);
}

export function verifyOperatorBootstrapAuth(authHeader) {
  return HUMAN_AUTH_ENABLED && verifyBearer(authHeader, OPERATOR_TOKEN);
}

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
