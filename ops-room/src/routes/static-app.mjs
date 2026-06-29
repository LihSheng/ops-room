import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APP_DIR = join(__dirname, '..', 'app');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const FILE_CACHE = {};

function readFileCached(filePath) {
  if (!FILE_CACHE[filePath]) {
    FILE_CACHE[filePath] = readFileSync(filePath);
  }
  return FILE_CACHE[filePath];
}

export function handleStaticApp(req, res, pathname) {
  let filePath;

  if (pathname === '/' || pathname === '') {
    filePath = join(APP_DIR, 'index.html');
  } else if (pathname === '/app.js') {
    filePath = join(APP_DIR, 'app.js');
  } else if (pathname === '/styles.css') {
    filePath = join(APP_DIR, 'styles.css');
  } else {
    return false;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = readFileCached(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
