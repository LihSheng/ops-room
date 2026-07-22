import { request } from 'node:http';

const PORT = process.env.OPENAB_WEBHOOK_PORT || '17380';
const BASE = `http://localhost:${PORT}`;
const DASHBOARD_TOKEN = process.env.OPS_ROOM_DASHBOARD_TOKEN || process.env.OPENAB_WEBHOOK_SECRET || '';
const SECRET_WORDS = ['token', 'secret', 'password', 'api_key', 'private_key', 'ghp_', 'ghs_'];

let exitCode = 0;

function fail(msg) {
  console.error('FAIL:', msg);
  exitCode = 1;
}

function check(condition, msg) {
  if (!condition) fail(msg);
}

function hasSecretWord(str) {
  if (typeof str !== 'string') return false;
  const lower = str.toLowerCase();
  for (const w of SECRET_WORDS) {
    if (lower.includes(w.toLowerCase())) return true;
  }
  return false;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    request(url, {
      method: 'GET',
      headers: DASHBOARD_TOKEN ? { Authorization: `Bearer ${DASHBOARD_TOKEN}` } : {},
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
      });
    }).on('error', reject).end();
  });
}

async function main() {
  console.log(`Smoke testing ${BASE}/api/openab/instances ...`);

  if (!DASHBOARD_TOKEN) {
    fail('Missing OPS_ROOM_DASHBOARD_TOKEN or OPENAB_WEBHOOK_SECRET');
    process.exit(exitCode);
  }

  let data;
  try {
    data = await fetchJSON(`${BASE}/api/openab/instances`);
  } catch (e) {
    fail(`Failed to fetch instances: ${e.message}`);
    process.exit(exitCode);
  }

  check(data, 'Response body is empty');
  check(Array.isArray(data.instances), 'Response has no instances array');

  const count = data.instances.length;
  check(count >= 4, `Expected at least 4 instances, got ${count}`);

  const agentNames = data.instances.map(i => i.agent);
  for (const expected of ['professor', 'berlin', 'tokyo', 'gemini']) {
    check(agentNames.includes(expected), `Missing expected agent: ${expected}`);
  }

  for (const inst of data.instances) {
    check(inst.agent, 'Instance missing agent');
    check(inst.container_name, `Instance ${inst.agent} missing container_name`);
    check(inst.backend, `Instance ${inst.agent} missing backend`);
    check(inst.runtime, `Instance ${inst.agent} missing runtime`);

    if (inst.runtime) {
      check(inst.runtime.status, `Instance ${inst.agent} missing runtime.status`);
      check(inst.runtime.health, `Instance ${inst.agent} missing runtime.health`);
    }

    const str = JSON.stringify(inst);
    for (const word of SECRET_WORDS) {
      check(!hasSecretWord(str), `Instance ${inst.agent} may contain secret word: ${word}`);
    }
  }

  check(data.docker !== undefined, 'Response missing docker field');

  if (data.docker) {
    check(typeof data.docker.available === 'boolean', 'docker.available should be boolean');
  }

  const pollingCount = data.instances.filter(i => i.github_polling_enabled).length;
  console.log(`  Instances: ${count}`);
  console.log(`  Polling enabled: ${pollingCount}`);
  console.log(`  Docker available: ${data.docker ? data.docker.available : 'N/A'}`);

  if (exitCode === 0) {
    console.log('OK: All smoke checks passed');
  } else {
    console.error(`FAIL: ${exitCode} check(s) failed`);
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
