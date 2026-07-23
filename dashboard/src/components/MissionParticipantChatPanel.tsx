import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Divider,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconMessageCircle2,
  IconRefresh,
  IconSend,
  IconShieldCheck,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';

import {
  createMissionChatIdempotencyKey,
  missionChatApi,
  MissionChatApiError,
  type MissionChatSession,
} from '../api/mission-chat';
import type { MissionRoom } from '../api/missions';
import { useOperatorAuth } from '../operator-auth';

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function stateColor(value: string) {
  if (value === 'open' || value === 'completed') return 'teal';
  if (value === 'needs_human') return 'orange';
  if (value === 'provider_pending') return 'blue';
  if (value === 'closed') return 'gray';
  return 'gray';
}

function timeLabel(value: string | null | undefined) {
  if (!value) return 'Time unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export function rolesAllowMissionChat(roles: readonly string[]) {
  return roles.includes('operator') || roles.includes('administrator');
}

function errorMessage(error: unknown) {
  if (!(error instanceof MissionChatApiError)) return null;
  const details = [error.errorCode, error.auditEventId ? `audit ${error.auditEventId}` : null]
    .filter(Boolean)
    .join(' · ');
  return `${error.message}${details ? ` (${details})` : ''}`;
}

function preferredParticipant(room: MissionRoom) {
  const current = room.timeline.find((stage) => stage.key === room.summary.current_stage_key)?.owner_agent;
  if (current && room.mission.participants.some((participant) => participant.agent_id === current)) return current;
  return room.mission.participants[0]?.agent_id || null;
}

export function MissionParticipantChatPanel({ room }: { room: MissionRoom }) {
  const auth = useOperatorAuth();
  const queryClient = useQueryClient();
  const missionId = room.mission.mission_id;
  const roles = auth.session?.session.roles || [];
  const canAccess = auth.mode === 'session' && rolesAllowMissionChat(roles);

  const chatQuery = useQuery({
    queryKey: ['mission-participant-chat', missionId],
    queryFn: () => missionChatApi.getForMission(missionId),
    enabled: canAccess,
    refetchInterval: canAccess ? 12_000 : false,
  });
  const session = chatQuery.data?.session || null;
  const canMutateMission = chatQuery.data?.can_mutate ?? !['completed', 'cancelled'].includes(room.mission.state);
  const participantOptions = useMemo(
    () => room.mission.participants.map((participant) => ({
      value: participant.agent_id,
      label: `${participant.agent_id} — ${participant.roles.join(', ')}`,
    })),
    [room.mission.participants],
  );

  const [targetAgentId, setTargetAgentId] = useState<string | null>(() => preferredParticipant(room));
  useEffect(() => {
    if (targetAgentId && room.mission.participants.some((participant) => participant.agent_id === targetAgentId)) return;
    setTargetAgentId(preferredParticipant(room));
  }, [room, targetAgentId]);

  const [createOpened, setCreateOpened] = useState(false);
  const [createReason, setCreateReason] = useState('Coordinate with declared Mission participants');
  const [createConfirmed, setCreateConfirmed] = useState(false);
  const [createKey, setCreateKey] = useState('');
  const [createPending, setCreatePending] = useState(false);
  const [createUncertain, setCreateUncertain] = useState(false);

  const [message, setMessage] = useState('');
  const [messageKey, setMessageKey] = useState<string | null>(null);
  const [messagePending, setMessagePending] = useState(false);
  const [messageUncertain, setMessageUncertain] = useState(false);

  const [closeOpened, setCloseOpened] = useState(false);
  const [closeReason, setCloseReason] = useState('Mission participant discussion is complete');
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [closeKey, setCloseKey] = useState('');
  const [closePending, setClosePending] = useState(false);
  const [closeUncertain, setCloseUncertain] = useState(false);

  const refresh = async (selectedSession: MissionChatSession | null = session) => {
    const keys: Array<readonly unknown[]> = [
      ['mission-participant-chat', missionId],
      ['mission-room', missionId],
      ['missions'],
      ['ops-dashboard'],
      ['interventions'],
      ['agent-fleet'],
    ];
    if (selectedSession) keys.push(['mission-chat-session', selectedSession.session_id]);
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  const openCreate = () => {
    setCreateOpened(true);
    setCreateReason('Coordinate with declared Mission participants');
    setCreateConfirmed(false);
    setCreateKey(createMissionChatIdempotencyKey());
    setCreateUncertain(false);
  };

  const submitCreate = async () => {
    if (!auth.session || !createReason.trim() || !createConfirmed || !createKey) return;
    setCreatePending(true);
    setCreateUncertain(false);
    try {
      const result = await missionChatApi.create({
        missionId,
        reason: createReason.trim(),
        idempotencyKey: createKey,
        csrfToken: auth.session.csrf_token,
      });
      await refresh(result.session);
      notifications.show({
        color: 'teal',
        title: result.domain_idempotent ? 'Mission chat already exists' : 'Mission chat created',
        message: `${result.session.title}${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`,
      });
      setCreateOpened(false);
    } catch (error) {
      const definite = errorMessage(error);
      if (definite) {
        notifications.show({ color: 'red', title: 'Mission chat rejected', message: definite });
        setCreateKey(createMissionChatIdempotencyKey());
        await refresh();
      } else {
        setCreateUncertain(true);
      }
    } finally {
      setCreatePending(false);
    }
  };

  const submitMessage = async () => {
    if (!auth.session || !session || session.state !== 'open' || !canMutateMission || !targetAgentId || !message.trim()) return;
    const retainedKey = messageKey || createMissionChatIdempotencyKey();
    setMessageKey(retainedKey);
    setMessagePending(true);
    setMessageUncertain(false);
    try {
      const result = await missionChatApi.send({
        sessionId: session.session_id,
        targetAgentId,
        content: message.trim(),
        idempotencyKey: retainedKey,
        csrfToken: auth.session.csrf_token,
      });
      await refresh(result.session);
      const needsHuman = result.turn.state === 'needs_human';
      notifications.show({
        color: needsHuman ? 'orange' : 'teal',
        title: needsHuman ? 'Participant turn needs attention' : result.domain_idempotent ? 'Message already accepted' : `${targetAgentId} replied`,
        message: needsHuman
          ? `${label(result.turn.error_code)}${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`
          : `A bounded final response was added to the Mission transcript${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`,
      });
      setMessage('');
      setMessageKey(null);
    } catch (error) {
      const definite = errorMessage(error);
      if (definite) {
        notifications.show({ color: 'red', title: 'Mission message rejected', message: definite });
        setMessageKey(null);
        await refresh();
      } else {
        setMessageUncertain(true);
      }
    } finally {
      setMessagePending(false);
    }
  };

  const openClose = () => {
    setCloseOpened(true);
    setCloseReason('Mission participant discussion is complete');
    setCloseConfirmed(false);
    setCloseKey(createMissionChatIdempotencyKey());
    setCloseUncertain(false);
  };

  const submitClose = async () => {
    if (!auth.session || !session || !closeReason.trim() || !closeConfirmed || !closeKey) return;
    setClosePending(true);
    setCloseUncertain(false);
    try {
      const result = await missionChatApi.close({
        sessionId: session.session_id,
        reason: closeReason.trim(),
        idempotencyKey: closeKey,
        csrfToken: auth.session.csrf_token,
      });
      await refresh(result.session);
      notifications.show({
        color: 'teal',
        title: result.domain_idempotent ? 'Mission chat already closed' : 'Mission chat closed',
        message: `${result.session.title}${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`,
      });
      setCloseOpened(false);
    } catch (error) {
      const definite = errorMessage(error);
      if (definite) {
        notifications.show({ color: 'red', title: 'Close rejected', message: definite });
        setCloseKey(createMissionChatIdempotencyKey());
        await refresh();
      } else {
        setCloseUncertain(true);
      }
    } finally {
      setClosePending(false);
    }
  };

  return (
    <Paper withBorder p="lg" id="mission-participant-chat">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="violet" size={40} radius="md"><IconUsers size={21} /></ThemeIcon>
            <Box>
              <Title order={3}>Mission participant chat</Title>
              <Text size="sm" c="dimmed" mt={3}>
                One durable conversation bound to this Mission and its declared participants.
              </Text>
            </Box>
          </Group>
          <Group gap={6}>
            {session && <Badge color={stateColor(session.state)} variant="light">{label(session.state)}</Badge>}
            <Button size="compact-sm" variant="subtle" leftSection={<IconRefresh size={14} />} loading={chatQuery.isFetching} disabled={!canAccess} onClick={() => { void refresh(); }}>
              Refresh
            </Button>
            {session && session.state !== 'closed' && (
              <Button size="compact-sm" color="red" variant="light" leftSection={<IconX size={14} />} onClick={openClose}>
                Close
              </Button>
            )}
          </Group>
        </Group>

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={17} />} title="Mission context, not Mission authority">
          Messages may clarify the objective and participant responsibilities. They cannot change tasks, Workflow stages, workspaces, SHAs, provider effects, Berlin decisions, approvals, or releases.
        </Alert>

        <Group gap={6}>
          {room.mission.participants.map((participant) => (
            <Badge key={participant.agent_id} variant="outline" color="violet">
              {participant.agent_id}: {participant.roles.join(', ')}
            </Badge>
          ))}
        </Group>

        {auth.mode === 'legacy' ? (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Human session required">
            Dashboard-token mode cannot read or create Mission participant chat.
          </Alert>
        ) : !rolesAllowMissionChat(roles) ? (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Agent chat permission required">
            This account does not have the <Code>agent.chat</Code> permission.
          </Alert>
        ) : chatQuery.isLoading ? (
          <Skeleton height={280} />
        ) : chatQuery.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Mission chat unavailable">
            Durable Mission chat evidence could not be loaded. No message was submitted.
          </Alert>
        ) : !session ? (
          <Stack align="center" justify="center" mih={220} ta="center">
            <ThemeIcon size={46} radius="xl" variant="light" color="violet"><IconMessageCircle2 size={23} /></ThemeIcon>
            <Text fw={700}>No Mission conversation yet</Text>
            <Text size="sm" c="dimmed" maw={620}>
              Create the Mission's single durable participant transcript. Session creation does not invoke any agent.
            </Text>
            {!canMutateMission && (
              <Alert color="gray" title="Terminal Mission is read only">
                This {label(room.mission.state)} Mission cannot create a new participant chat.
              </Alert>
            )}
            <Button disabled={!canMutateMission} onClick={openCreate}>Create Mission chat</Button>
          </Stack>
        ) : (
          <Stack gap="md">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <Box>
                <Text fw={700}>{session.title}</Text>
                <Text size="xs" c="dimmed">Created by {session.created_by.actor_display_name} · {timeLabel(session.created_at)}</Text>
                <Text size="xs" ff="monospace" c="dimmed">{session.session_id}</Text>
              </Box>
              <Badge color={canMutateMission ? 'teal' : 'gray'} variant="light">
                Mission {canMutateMission ? 'conversation enabled' : 'read only'}
              </Badge>
            </Group>

            {!canMutateMission && (
              <Alert color="gray" title="Terminal Mission transcript">
                The Mission is {label(room.mission.state)}. Historical messages remain visible, but no participant may be invoked.
              </Alert>
            )}
            {session.state === 'needs_human' && (
              <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Participant turn needs human attention">
                {label(session.last_error)}. The interrupted or failed turn was not replayed automatically.
              </Alert>
            )}

            <ScrollArea.Autosize mah={520} offsetScrollbars>
              <Stack gap="sm" pr="xs">
                {session.turns.length === 0 ? (
                  <Text size="sm" c="dimmed">No messages yet.</Text>
                ) : session.turns.map((turn) => (
                  <Stack key={turn.turn_id} gap={6}>
                    <Paper withBorder p="sm" bg="gray.0" ml="15%">
                      <Group justify="space-between" gap="xs">
                        <Text size="xs" c="dimmed" fw={700}>{turn.human_message.actor.actor_display_name} · {timeLabel(turn.human_message.created_at)}</Text>
                        <Badge size="xs" variant="outline">To {turn.target_agent_id}</Badge>
                      </Group>
                      <Text size="sm" mt={5} style={{ whiteSpace: 'pre-wrap' }}>{turn.human_message.content}</Text>
                    </Paper>
                    {turn.agent_message ? (
                      <Paper withBorder p="sm" mr="15%">
                        <Group justify="space-between" gap="xs">
                          <Text size="xs" c="dimmed" fw={700}>{turn.agent_message.agent_id} · {timeLabel(turn.agent_message.created_at)}</Text>
                          <Badge size="xs" variant="outline">{turn.agent_message.model}</Badge>
                        </Group>
                        <Text size="sm" mt={5} style={{ whiteSpace: 'pre-wrap' }}>{turn.agent_message.content}</Text>
                      </Paper>
                    ) : (
                      <Alert color={turn.state === 'provider_pending' ? 'blue' : 'orange'} variant="light" title={turn.state === 'provider_pending' ? `${turn.target_agent_id} response pending` : 'No final response recorded'}>
                        {turn.state === 'provider_pending' ? 'The addressed message is durably recorded while the bounded provider turn runs.' : label(turn.error_code)}
                      </Alert>
                    )}
                  </Stack>
                ))}
              </Stack>
            </ScrollArea.Autosize>

            <Divider />
            <Select
              label="Address participant"
              description="Only agents declared in this Mission are available."
              data={participantOptions}
              value={targetAgentId}
              onChange={setTargetAgentId}
              disabled={!canMutateMission || session.state !== 'open' || messagePending}
              allowDeselect={false}
            />
            <Textarea
              label="Message"
              description="Maximum 4,000 characters. This is conversation context, not a task or approval."
              minRows={3}
              maxRows={8}
              maxLength={4_000}
              value={message}
              onChange={(event) => {
                setMessage(event.currentTarget.value);
                if (!messageKey) setMessageKey(createMissionChatIdempotencyKey());
              }}
              disabled={!canMutateMission || session.state !== 'open' || messagePending}
              placeholder={session.state === 'open' && canMutateMission ? 'Ask the selected participant for clarification or a bounded summary...' : 'This Mission chat is read only.'}
            />
            {messageUncertain && (
              <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Server response was not received">
                The same participant, message, and request identity are retained. Retrying cannot create a second provider turn for an accepted message.
              </Alert>
            )}
            <Group justify="flex-end">
              <Button leftSection={<IconSend size={15} />} loading={messagePending} disabled={!canMutateMission || session.state !== 'open' || !targetAgentId || !message.trim()} onClick={() => { void submitMessage(); }}>
                Send to {targetAgentId || 'participant'}
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>

      <Modal opened={createOpened} onClose={() => { if (!createPending) setCreateOpened(false); }} title="Create Mission participant chat" centered closeOnClickOutside={!createPending} closeOnEscape={!createPending}>
        <Stack gap="md">
          <Alert color="violet" variant="light" title="One Mission-owned transcript">
            This creates the Mission's single shared participant conversation. No agent is invoked until a targeted message is sent.
          </Alert>
          <Textarea label="Operator reason" description="Required for actor-attributed audit evidence." maxLength={500} minRows={2} value={createReason} onChange={(event) => setCreateReason(event.currentTarget.value)} disabled={createPending} required />
          <Checkbox checked={createConfirmed} onChange={(event) => setCreateConfirmed(event.currentTarget.checked)} disabled={createPending} label="I understand this conversation grants no task, Workflow, workspace, approval, or release authority." />
          {createUncertain && <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Server response was not received">The same create request identity is retained for a safe retry.</Alert>}
          <Group justify="flex-end"><Button variant="default" onClick={() => setCreateOpened(false)} disabled={createPending}>Cancel</Button><Button loading={createPending} disabled={!createReason.trim() || !createConfirmed} onClick={() => { void submitCreate(); }}>Create chat</Button></Group>
        </Stack>
      </Modal>

      <Modal opened={closeOpened} onClose={() => { if (!closePending) setCloseOpened(false); }} title="Close Mission participant chat" centered closeOnClickOutside={!closePending} closeOnEscape={!closePending}>
        <Stack gap="md">
          <Alert color="red" variant="light" title="Exact consequence">
            This Mission conversation becomes read only. Its bounded transcript remains durable evidence and no participant is invoked.
          </Alert>
          <Textarea label="Operator reason" maxLength={500} minRows={2} value={closeReason} onChange={(event) => setCloseReason(event.currentTarget.value)} disabled={closePending} required />
          <Checkbox checked={closeConfirmed} onChange={(event) => setCloseConfirmed(event.currentTarget.checked)} disabled={closePending} label="I understand the Mission chat will become read only." />
          {closeUncertain && <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Server response was not received">The same close request identity is retained for a safe retry.</Alert>}
          <Group justify="flex-end"><Button variant="default" onClick={() => setCloseOpened(false)} disabled={closePending}>Cancel</Button><Button color="red" loading={closePending} disabled={!closeReason.trim() || !closeConfirmed} onClick={() => { void submitClose(); }}>Close chat</Button></Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
