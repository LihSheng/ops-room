from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(relative_path: str, old: str, new: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'expected one match in {relative_path}, found {count}: {old[:100]!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


http_path = ROOT / 'ops-room/src/server/http.ts'
http = http_path.read_text(encoding='utf-8')
http = http.replace(
    "import { sendJSON, verifyAuth, verifyDashboardReadRequest, parseBody } from '../routes/helpers.js';",
    "import { sendJSON, verifyAuth, requiresDashboardReadAuth, parseBody } from '../routes/helpers.js';",
    1,
)
http = http.replace(
    "} from '../services/operator-request-auth.js';\n",
    "} from '../services/operator-request-auth.js';\nimport { authorizeDashboardReadRequest } from '../services/dashboard-request-auth.js';\n",
    1,
)
anchor = "  if (req.method === 'GET' && pathname === '/api/operator/sessions') {"
guard = """  if (requiresDashboardReadAuth(req)) {
    const authorization = await authorizeDashboardReadRequest({ req });
    if (!authorization.ok) {
      sendJSON(res, authorization.status, {
        error: authorization.error,
        error_code: authorization.error_code,
      });
      return;
    }
  }

"""
if http.count(anchor) != 1:
    raise RuntimeError('dashboard read guard anchor missing')
http = http.replace(anchor, guard + anchor, 1)
legacy_guard = "    if (!verifyDashboardReadRequest(req)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }\n"
if http.count(legacy_guard) != 5:
    raise RuntimeError(f'expected five legacy dashboard guards, found {http.count(legacy_guard)}')
http = http.replace(legacy_guard, '')
http_path.write_text(http, encoding='utf-8')

app_path = ROOT / 'ops-room/dashboard/src/App.tsx'
app = app_path.read_text(encoding='utf-8')
app = app.replace(
    "  IconListCheck,\n  IconRefresh,",
    "  IconListCheck,\n  IconLogout,\n  IconRefresh,",
    1,
)
app = app.replace(
    "import { opsApi } from './api';\n",
    "import { opsApi } from './api';\nimport { OperatorAuthBoundary, useOperatorAuth } from './operator-auth';\n",
    1,
)
app = app.replace('export default function App() {', 'function OpsRoomApp() {', 1)
app = app.replace(
    "  const queryClient = useQueryClient();\n  const location = useLocation();",
    "  const queryClient = useQueryClient();\n  const auth = useOperatorAuth();\n  const location = useLocation();",
    1,
)
app = app.replace(
    "  const lastUpdated = useMemo(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), [queryClient.getQueryState(['ops-dashboard'])?.dataUpdatedAt]);",
    "  const lastUpdated = useMemo(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), [queryClient.getQueryState(['ops-dashboard'])?.dataUpdatedAt]);\n  const operatorName = auth.session?.session.actor.actor_display_name || auth.session?.session.actor.actor_id || 'Operator';\n  const operatorRoles = auth.session?.session.roles.join(', ') || '';",
    1,
)
old_header = """          <Group gap="md"><Group gap={6} visibleFrom="sm"><Badge variant="dot" color="teal">Live</Badge><Text size="xs" c="dimmed">Updated {lastUpdated}</Text></Group><Tooltip label="Refresh all data"><ActionIcon variant="default" size="lg" onClick={() => { queryClient.invalidateQueries({ queryKey: ['ops-dashboard'] }); queryClient.invalidateQueries({ queryKey: ['agent-profiles'] }); queryClient.invalidateQueries({ queryKey: ['agent-profile'] }); queryClient.invalidateQueries({ queryKey: ['skills-catalog'] }); queryClient.invalidateQueries({ queryKey: ['memory-spaces'] }); queryClient.invalidateQueries({ queryKey: ['openab-instances'] }); }}><IconRefresh size={17} /></ActionIcon></Tooltip></Group>"""
new_header = """          <Group gap="md">
            <Group gap={6} visibleFrom="sm"><Badge variant="dot" color="teal">Live</Badge><Text size="xs" c="dimmed">Updated {lastUpdated}</Text></Group>
            {auth.mode === 'session' && auth.session ? (
              <Group gap="xs" wrap="nowrap">
                <Avatar size={30} radius="xl" color="violet">{operatorName.slice(0, 2).toUpperCase()}</Avatar>
                <Box visibleFrom="sm">
                  <Text size="sm" fw={600} lh={1.1}>{operatorName}</Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>{operatorRoles}</Text>
                </Box>
                <Tooltip label="Sign out">
                  <ActionIcon variant="default" size="lg" disabled={auth.logoutPending} onClick={() => { void auth.logout(); }}>
                    <IconLogout size={17} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ) : <Badge variant="light" color="gray">Dashboard token</Badge>}
            <Tooltip label="Refresh all data"><ActionIcon variant="default" size="lg" onClick={() => { queryClient.invalidateQueries({ queryKey: ['ops-dashboard'] }); queryClient.invalidateQueries({ queryKey: ['agent-profiles'] }); queryClient.invalidateQueries({ queryKey: ['agent-profile'] }); queryClient.invalidateQueries({ queryKey: ['skills-catalog'] }); queryClient.invalidateQueries({ queryKey: ['memory-spaces'] }); queryClient.invalidateQueries({ queryKey: ['openab-instances'] }); }}><IconRefresh size={17} /></ActionIcon></Tooltip>
          </Group>"""
if app.count(old_header) != 1:
    raise RuntimeError('app header anchor missing')
app = app.replace(old_header, new_header, 1)
app = app.rstrip() + """

export default function App() {
  return (
    <OperatorAuthBoundary>
      <OpsRoomApp />
    </OperatorAuthBoundary>
  );
}
"""
app_path.write_text(app, encoding='utf-8')
