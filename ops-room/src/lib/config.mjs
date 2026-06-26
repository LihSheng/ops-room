export const AGENT_IDS = {
  professor: '1518980056880517140',
  berlin: '1518983231012208903',
  tokyo: '1518982568920355017',
};

export const AGENT_ALIASES = {
  alpha: 'berlin',
  beta: 'tokyo',
};

export const POLL_AGENTS = ['professor', 'berlin', 'tokyo'];

export const AGENT_NAMES = {
  alpha: 'Berlin',
  beta: 'Tokyo',
  professor: 'Professor',
  berlin: 'Berlin',
  tokyo: 'Tokyo',
};

export const BOT_USERS = {
  professor: 'lihsheng-professor[bot]',
  berlin: 'lihsheng-berlin[bot]',
  tokyo: 'lihsheng-tokyo[bot]',
};

export const GITHUB_APP_CONFIG = {
  professor: {
    appId: 'GITHUB_APP_ID',
    installationId: 'GITHUB_APP_INSTALLATION_ID',
    keyPath: 'GITHUB_APP_KEY_PATH',
    botUser: 'GITHUB_APP_BOT_USER',
  },
  berlin: {
    appId: 'GITHUB_APP_ID_BERLIN',
    installationId: 'GITHUB_APP_INSTALLATION_ID_BERLIN',
    keyPath: 'GITHUB_APP_KEY_PATH_BERLIN',
    botUser: 'GITHUB_APP_BOT_USER_BERLIN',
  },
  tokyo: {
    appId: 'GITHUB_APP_ID_TOKYO',
    installationId: 'GITHUB_APP_INSTALLATION_ID_TOKYO',
    keyPath: 'GITHUB_APP_KEY_PATH_TOKYO',
    botUser: 'GITHUB_APP_BOT_USER_TOKYO',
  },
};

export const CODING_KEYWORDS = [
  'implement',
  'fix',
  'create pr',
  'pull request',
  'change code',
  'change files',
  'modify code',
  'update code',
  'add feature',
  'refactor',
  'run tests',
  'commit',
  'push branch',
  'open a pr',
  'create a branch',
  'work on it',
  'coding task',
];

export const LABEL_COLORS = {
  pending: '5319e7',
  wip: 'fbca04',
  failed: 'd73a4a',
  done: '0e8a16',
  pr: '0e8a16',
  needsHuman: 'b60205',
};

export function normalizeAgent(agent) {
  const key = String(agent || '').toLowerCase();
  return AGENT_ALIASES[key] || key;
}
