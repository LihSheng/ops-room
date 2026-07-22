import {
  Alert,
  Box,
  Button,
  Center,
  Container,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconLock, IconShieldCheck } from '@tabler/icons-react';
import { createContext, useContext, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import {
  OperatorAuthError,
  operatorAuthApi,
  type OperatorSessionResponse,
} from './api/operator-auth';

const OPERATOR_SESSION_QUERY_KEY = ['operator-session'] as const;

type OperatorAuthContextValue = {
  mode: 'legacy' | 'session';
  session: OperatorSessionResponse | null;
  logout: () => Promise<void>;
  logoutPending: boolean;
};

const OperatorAuthContext = createContext<OperatorAuthContextValue | null>(null);

export function useOperatorAuth(): OperatorAuthContextValue {
  const value = useContext(OperatorAuthContext);
  if (!value) throw new Error('OperatorAuthBoundary is missing');
  return value;
}

function LoginScreen({
  login,
  pending,
  error,
}: {
  login: (token: string) => Promise<void>;
  pending: boolean;
  error: string | null;
}) {
  const [token, setToken] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    await login(value);
    setToken('');
  };

  return (
    <Center mih="100vh" px="md" bg="var(--mantine-color-gray-0)">
      <Container size={440} w="100%">
        <Stack gap="lg">
          <Stack align="center" gap={8} ta="center">
            <ThemeIcon size={52} radius="xl" variant="light" color="violet">
              <IconShieldCheck size={26} />
            </ThemeIcon>
            <Box>
              <Title order={2}>Operator access</Title>
              <Text c="dimmed" size="sm" mt={6}>
                Sign in to Ops Room with the dedicated operator credential.
              </Text>
            </Box>
          </Stack>

          <Paper withBorder shadow="sm" radius="lg" p="xl">
            <form onSubmit={submit}>
              <Stack gap="md">
                {error && (
                  <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Sign-in failed">
                    {error}
                  </Alert>
                )}
                <PasswordInput
                  label="Operator token"
                  description="The token is exchanged once for an HttpOnly browser session and is not stored."
                  placeholder="Paste OPS_ROOM_OPERATOR_TOKEN"
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                  autoComplete="current-password"
                  leftSection={<IconLock size={16} />}
                  disabled={pending}
                  required
                />
                <Button type="submit" loading={pending} disabled={!token.trim()} fullWidth>
                  Sign in
                </Button>
              </Stack>
            </form>
          </Paper>

          <Text size="xs" c="dimmed" ta="center">
            Dashboard and webhook credentials are not accepted as human credentials.
          </Text>
        </Stack>
      </Container>
    </Center>
  );
}

function AuthUnavailable({ error, retry }: { error: string; retry: () => void }) {
  return (
    <Center mih="100vh" px="md">
      <Paper withBorder radius="lg" p="xl" maw={520}>
        <Stack align="center" gap="md" ta="center">
          <ThemeIcon size={48} radius="xl" color="red" variant="light">
            <IconAlertTriangle size={24} />
          </ThemeIcon>
          <Box>
            <Title order={3}>Authentication unavailable</Title>
            <Text c="dimmed" size="sm" mt={6}>{error}</Text>
          </Box>
          <Button variant="default" onClick={retry}>Retry</Button>
        </Stack>
      </Paper>
    </Center>
  );
}

export function OperatorAuthBoundary({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: OPERATOR_SESSION_QUERY_KEY,
    queryFn: operatorAuthApi.readSession,
    retry: false,
    staleTime: 30_000,
  });

  const loginMutation = useMutation({
    mutationFn: operatorAuthApi.createSession,
    onSuccess: (session) => {
      queryClient.setQueryData(OPERATOR_SESSION_QUERY_KEY, session);
      notifications.show({ color: 'teal', title: 'Signed in', message: `Authenticated as ${session.session.actor.actor_display_name}` });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async (session: OperatorSessionResponse) => operatorAuthApi.revokeSession(session.csrf_token),
    onSuccess: async () => {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== OPERATOR_SESSION_QUERY_KEY[0],
      });
      await sessionQuery.refetch();
      notifications.show({ color: 'teal', title: 'Signed out', message: 'The browser session has been revoked.' });
    },
  });

  if (sessionQuery.isPending) {
    return <Center mih="100vh"><Loader /></Center>;
  }

  const queryError = sessionQuery.error instanceof OperatorAuthError ? sessionQuery.error : null;
  if (sessionQuery.isError && queryError?.status === 404) {
    return (
      <OperatorAuthContext.Provider value={{ mode: 'legacy', session: null, logout: async () => {}, logoutPending: false }}>
        {children}
      </OperatorAuthContext.Provider>
    );
  }

  if (sessionQuery.isError && queryError?.status === 401) {
    const loginError = loginMutation.error instanceof OperatorAuthError
      ? loginMutation.error.message
      : loginMutation.error
        ? 'Unable to create an operator session.'
        : null;
    return (
      <LoginScreen
        pending={loginMutation.isPending}
        error={loginError}
        login={async (token) => {
          await loginMutation.mutateAsync(token);
        }}
      />
    );
  }

  if (sessionQuery.isError || !sessionQuery.data) {
    return (
      <AuthUnavailable
        error={queryError?.message || 'The operator session endpoint could not be reached.'}
        retry={() => { void sessionQuery.refetch(); }}
      />
    );
  }

  const session = sessionQuery.data;
  return (
    <OperatorAuthContext.Provider value={{
      mode: 'session',
      session,
      logout: async () => { await logoutMutation.mutateAsync(session); },
      logoutPending: logoutMutation.isPending,
    }}>
      {children}
    </OperatorAuthContext.Provider>
  );
}
