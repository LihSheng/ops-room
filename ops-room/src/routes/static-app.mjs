import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(__dirname, '..', '..', 'dist', 'dashboard');
const INDEX_FILE = join(DIST_DIR, 'index.html');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const FILE_CACHE = new Map();

function readFileCached(filePath) {
  if (!FILE_CACHE.has(filePath)) {
    FILE_CACHE.set(filePath, readFileSync(filePath));
  }
  return FILE_CACHE.get(filePath);
}

function isInsideDist(filePath) {
  const pathFromDist = relative(DIST_DIR, filePath);
  return pathFromDist !== '' && !pathFromDist.startsWith('..') && !pathFromDist.includes(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

function safeAssetPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const normalized = normalize(decoded).replace(/^[/\\]+/, '');
  const candidate = resolve(DIST_DIR, normalized);
  return isInsideDist(candidate) ? candidate : null;
}

function sendFile(res, filePath, cacheControl) {
  const content = readFileCached(filePath);
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(content);
}

export function handleStaticApp(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname.startsWith('/api/') || pathname === '/api' || pathname === '/health') return false;

  try {
    const assetPath = safeAssetPath(pathname);
    if (assetPath && statSync(assetPath).isFile()) {
      const immutable = pathname.startsWith('/assets/');
      sendFile(res, assetPath, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      return true;
    }
  } catch {
    // Client-side routes intentionally fall through to index.html.
  }

  try {
    sendFile(res, INDEX_FILE, 'no-cache');
    return true;
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Dashboard build not found. Run npm install or npm run build:dashboard in ops-room/.');
    return true;
  }
}
