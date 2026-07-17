import crypto from 'crypto';
import fs from 'fs';

const APP_ID = process.env.GITHUB_APP_ID;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const KEY_PATH = process.env.GITHUB_APP_KEY_PATH;

if (!APP_ID || !INSTALLATION_ID || !KEY_PATH) {
  console.error('Missing: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_KEY_PATH');
  process.exit(1);
}

function b64url(buf) {
  return buf.toString('base64url');
}

function createJWT(appId, pem) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ iat: now, exp: now + 600, iss: appId })));
  const sign = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), pem);
  return `${header}.${payload}.${b64url(sign)}`;
}

const pem = fs.readFileSync(KEY_PATH, 'utf8');
const jwt = createJWT(APP_ID, pem);

const url = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github.v3+json',
  },
});

if (!res.ok) {
  const text = await res.text();
  console.error(`Token exchange failed (${res.status}): ${text}`);
  process.exit(1);
}

const data = await res.json();
const expiresAt = new Date(data.expires_at);
const ttl = Math.floor((expiresAt - new Date()) / 1000);

process.stdout.write(JSON.stringify({ token: data.token, expires_at: data.expires_at, ttl }));
