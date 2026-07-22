import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearOperatorSessionCookie, createOperatorSession, extractOperatorSessionToken, readOperatorSession, revokeOperatorSession, serializeOperatorSessionCookie, } from '../src/services/operator-session-store.js';
const TOKEN = 'A'.repeat(43);
const CREATED_AT = '2026-07-22T05:00:00.000Z';
const actor = {
    actor_id: 'operator:lih-sheng',
    actor_display_name: 'Lih Sheng',
};
async function sessionDir() {
    return mkdtemp(join(tmpdir(), 'ops-room-operator-session-'));
}
test('creates an opaque durable session without persisting the raw token', async () => {
    const dir = await sessionDir();
    const result = await createOperatorSession({
        dir,
        actor,
        roles: ['operator', 'reviewer'],
        ttlSeconds: 3600,
        now: () => CREATED_AT,
        generateToken: () => TOKEN,
    });
    assert.equal(result.token, TOKEN);
    assert.equal(result.ttl_seconds, 3600);
    assert.equal(result.session.actor.actor_id, actor.actor_id);
    assert.deepEqual(result.session.roles, ['operator', 'reviewer']);
    assert.equal(result.session.created_at, CREATED_AT);
    assert.equal(result.session.expires_at, '2026-07-22T06:00:00.000Z');
    const files = await readdir(dir);
    assert.deepEqual(files, [`session-${createHash('sha256').update(TOKEN).digest('hex')}.json`]);
    const stored = await readFile(join(dir, files[0]), 'utf8');
    assert.equal(stored.includes(TOKEN), false);
    assert.equal(stored.includes(createHash('sha256').update(TOKEN).digest('hex')), true);
});
test('reads a valid session and rejects expiry or malformed tokens', async () => {
    const dir = await sessionDir();
    await createOperatorSession({
        dir,
        actor,
        roles: 'viewer',
        ttlSeconds: 300,
        now: () => CREATED_AT,
        generateToken: () => TOKEN,
    });
    const active = await readOperatorSession({
        dir,
        token: TOKEN,
        now: () => '2026-07-22T05:04:59.000Z',
    });
    assert.equal(active?.actor.actor_id, actor.actor_id);
    assert.deepEqual(active?.roles, ['viewer']);
    assert.equal(await readOperatorSession({
        dir,
        token: TOKEN,
        now: () => '2026-07-22T05:05:00.000Z',
    }), null);
    assert.equal(await readOperatorSession({ dir, token: 'not-a-token' }), null);
    assert.equal(await readOperatorSession({ dir, token: 'B'.repeat(43) }), null);
});
test('revocation is durable and idempotent', async () => {
    const dir = await sessionDir();
    await createOperatorSession({
        dir,
        actor,
        roles: ['administrator'],
        ttlSeconds: 3600,
        now: () => CREATED_AT,
        generateToken: () => TOKEN,
    });
    const first = await revokeOperatorSession({
        dir,
        token: TOKEN,
        now: () => '2026-07-22T05:10:00.000Z',
    });
    assert.equal(first?.session_id.startsWith('session:'), true);
    assert.equal(await readOperatorSession({
        dir,
        token: TOKEN,
        now: () => '2026-07-22T05:11:00.000Z',
    }), null);
    const replay = await revokeOperatorSession({
        dir,
        token: TOKEN,
        now: () => '2026-07-22T05:12:00.000Z',
    });
    assert.equal(replay?.session_id, first?.session_id);
});
test('cookie helpers enforce one bounded HttpOnly session cookie', () => {
    const cookie = serializeOperatorSessionCookie({ token: TOKEN, ttlSeconds: 3600 });
    assert.match(cookie, /^ops_room_session=/);
    assert.match(cookie, /Path=\/api/);
    assert.match(cookie, /Max-Age=3600/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.equal(extractOperatorSessionToken(`other=value; ${cookie.split(';')[0]}`), TOKEN);
    assert.equal(extractOperatorSessionToken(`ops_room_session=${TOKEN}; ops_room_session=${TOKEN}`), null);
    assert.equal(extractOperatorSessionToken('ops_room_session=invalid'), null);
    const localCookie = serializeOperatorSessionCookie({ token: TOKEN, ttlSeconds: 3600, secure: false });
    assert.equal(localCookie.includes('Secure'), false);
    const cleared = clearOperatorSessionCookie();
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /HttpOnly/);
});
test('invalid actors, roles, TTLs, and generated tokens fail closed', async () => {
    const dir = await sessionDir();
    await assert.rejects(createOperatorSession({
        dir,
        actor: { ...actor, actor_id: '../root' },
        roles: ['operator'],
        ttlSeconds: 3600,
        generateToken: () => TOKEN,
    }), /operator_session_actor_invalid/);
    await assert.rejects(createOperatorSession({
        dir,
        actor,
        roles: ['owner'],
        ttlSeconds: 3600,
        generateToken: () => TOKEN,
    }), /operator_role_unknown:owner/);
    await assert.rejects(createOperatorSession({
        dir,
        actor,
        roles: ['operator'],
        ttlSeconds: 30,
        generateToken: () => TOKEN,
    }), /operator_session_ttl_invalid/);
    await assert.rejects(createOperatorSession({
        dir,
        actor,
        roles: ['operator'],
        ttlSeconds: 3600,
        generateToken: () => 'predictable',
    }), /operator_session_token_invalid/);
});
//# sourceMappingURL=operator-session-store.test.js.map