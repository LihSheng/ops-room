const REDACTED = 'REDACTED';

const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g;
const SECRET_ASSIGNMENT = /((?:api[_-]?key|token|secret|password|credential|private[_-]?key)\s*[=:]\s*["']?)[^\s"',;]+/gi;

/**
 * Redact credential-shaped values before they reach logs, HTTP responses,
 * GitHub comments, or other externally visible surfaces.
 *
 * This is a defence-in-depth control. Callers must still avoid placing
 * credentials in command arguments, repository files, or task payloads.
 */
export function redactSecrets(value) {
  return String(value ?? '')
    .replaceAll('\u0000', '')
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]')
    .replace(/https:\/\/x-access-token:[^@\s/]+@/gi, `https://x-access-token:${REDACTED}@`)
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s"',;]+/gi, `$1${REDACTED}`)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bnvapi-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bM(?:FA|T)[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}\b/g, REDACTED)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`);
}
