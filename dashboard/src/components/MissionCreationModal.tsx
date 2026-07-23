import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconCheck,
  IconGitBranch,
  IconRoute,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import {
  MissionApiError,
  missionsApi,
  type CreateMissionRequest,
  type MissionPriority,
  type MissionRecord,
} from '../api/missions';

type MissionFormState = {
  title: string;
  objective: string;
  repository: string;
  startingBranch: string;
  startingSha: string;
  maxIterations: number;
  priority: MissionPriority;
  githubIssue: string;
  deadline: string;
  referenceDocuments: string;
  requiredCapabilities: string;
  supportingContext: string;
  reason: string;
};

const INITIAL_FORM: MissionFormState = {
  title: '',
  objective: '',
  repository: '',
  startingBranch: 'main',
  startingSha: '',
  maxIterations: 3,
  priority: 'normal',
  githubIssue: '',
  deadline: '',
  referenceDocuments: '',
  requiredCapabilities: '',
  supportingContext: '',
  reason: '',
};

const REPOSITORY_PATTERN = /^(?:[A-Za-z0-9._-]{1,120}|[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})$/;
const BRANCH_PATTERN = /^(?!\/|.*(?:\.\.|\/\.|\.\/|\/\/|@\{|\\))[A-Za-z0-9._\/-]{1,240}(?<![./])$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

function newRequestKey() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `mission-create-${random}`;
}

function splitList(value: string) {
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

function validationError(form: MissionFormState): string | null {
  if (!form.title.trim() || form.title.trim().length > 160) {
    return 'Mission title is required and must not exceed 160 characters.';
  }
  if (!form.objective.trim() || form.objective.trim().length > 5_000) {
    return 'Mission objective is required and must not exceed 5,000 characters.';
  }
  const repository = form.repository.trim();
  if (!REPOSITORY_PATTERN.test(repository) || repository.includes('..')) {
    return 'Repository must be a bounded repository ID such as LihSheng/ops-room.';
  }
  if (!BRANCH_PATTERN.test(form.startingBranch.trim())) {
    return 'Starting branch is not a valid bounded Git branch name.';
  }
  if (!SHA_PATTERN.test(form.startingSha.trim())) {
    return 'Starting SHA must be the exact 40-character commit SHA.';
  }
  if (!Number.isInteger(form.maxIterations) || form.maxIterations < 1 || form.maxIterations > 20) {
    return 'Maximum iterations must be between 1 and 20.';
  }
  if (form.githubIssue.trim()) {
    const issue = Number(form.githubIssue);
    if (!Number.isInteger(issue) || issue < 1 || issue > 999_999_999) {
      return 'GitHub issue must be a positive integer.';
    }
  }
  if (form.deadline && Number.isNaN(new Date(form.deadline).getTime())) {
    return 'Deadline must be a valid date and time.';
  }
  const references = splitList(form.referenceDocuments);
  if (references.length > 20 || references.some((reference) => (
    reference.length > 500
    || /^file:/i.test(reference)
    || reference.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(reference)
  ))) {
    return 'Reference documents must contain at most 20 safe identifiers or URLs.';
  }
  const capabilities = splitList(form.requiredCapabilities).map((value) => value.toLowerCase());
  if (capabilities.length > 30 || capabilities.some((capability) => !CAPABILITY_PATTERN.test(capability))) {
    return 'Capabilities must use lowercase letters, numbers, dot, colon, underscore, or dash.';
  }
  if (form.supportingContext.trim().length > 5_000) {
    return 'Supporting context must not exceed 5,000 characters.';
  }
  if (!form.reason.trim() || form.reason.trim().length > 500) {
    return 'An operator reason is required and must not exceed 500 characters.';
  }
  return null;
}

export function MissionCreationModal({
  opened,
  onClose,
  csrfToken,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  csrfToken: string | null;
  onCreated?: (mission: MissionRecord) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<MissionFormState>(INITIAL_FORM);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [attempted, setAttempted] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (request: CreateMissionRequest) => {
      if (!csrfToken) throw new Error('A valid human session is required to create a mission.');
      return missionsApi.createMission(request, csrfToken);
    },
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['missions'] }),
        queryClient.invalidateQueries({ queryKey: ['agent-fleet'] }),
      ]);
      notifications.show({
        color: 'teal',
        title: response.idempotent_replay ? 'Mission already recorded' : 'Mission created',
        message: `${response.mission.title} is planned. No workflow has been started.`,
      });
      onCreated?.(response.mission);
      setForm(INITIAL_FORM);
      setRequestKey(newRequestKey());
      setAttempted(false);
      setClientError(null);
      mutation.reset();
      onClose();
    },
  });

  const updateField = <K extends keyof MissionFormState>(field: K, value: MissionFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setClientError(null);
    if (attempted) {
      setAttempted(false);
      setRequestKey(newRequestKey());
      mutation.reset();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const error = validationError(form);
    if (error) {
      setClientError(error);
      return;
    }

    setAttempted(true);
    setClientError(null);
    const githubIssue = form.githubIssue.trim() ? Number(form.githubIssue) : undefined;
    const deadline = form.deadline ? new Date(form.deadline).toISOString() : undefined;

    await mutation.mutateAsync({
      title: form.title.trim(),
      objective: form.objective.trim(),
      repository: form.repository.trim(),
      starting_branch: form.startingBranch.trim(),
      starting_sha: form.startingSha.trim().toLowerCase(),
      workflow_type: 'feature-development',
      max_iterations: form.maxIterations,
      approval_policy: 'berlin-review-required',
      github_issue: githubIssue,
      reference_documents: splitList(form.referenceDocuments),
      required_capabilities: splitList(form.requiredCapabilities).map((value) => value.toLowerCase()),
      priority: form.priority,
      deadline,
      supporting_context: form.supportingContext.trim() || undefined,
      reason: form.reason.trim(),
      idempotency_key: requestKey,
    }).catch(() => {
      // The bounded error is rendered below and the same key remains available for a safe retry.
    });
  };

  const apiError = mutation.error instanceof MissionApiError ? mutation.error : null;
  const errorMessage = clientError
    || apiError?.message
    || (mutation.error instanceof Error ? mutation.error.message : null);

  return (
    <Modal
      opened={opened}
      onClose={() => { if (!mutation.isPending) onClose(); }}
      title="Create mission"
      size="xl"
      centered
      closeOnClickOutside={!mutation.isPending}
      closeOnEscape={!mutation.isPending}
    >
      <form onSubmit={submit}>
        <Stack gap="lg">
          <Alert color="violet" variant="light" icon={<IconRoute size={18} />} title="Records intent only">
            Creating a mission writes a durable planned record. It does not start a workflow, allocate a workspace, dispatch an agent, or invoke a provider.
          </Alert>

          {errorMessage && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Mission was not created">
              <Stack gap={4}>
                <Text size="sm">{errorMessage}</Text>
                {apiError?.errorCode && <Text size="xs" c="dimmed">Code: {apiError.errorCode}</Text>}
                {apiError?.auditEventId && <Text size="xs" c="dimmed">Audit event: {apiError.auditEventId}</Text>}
              </Stack>
            </Alert>
          )}

          <Box>
            <Text fw={700}>Mission objective</Text>
            <Text size="sm" c="dimmed">Define the bounded objective and exact repository starting point.</Text>
          </Box>

          <Grid>
            <Grid.Col span={12}>
              <TextInput
                label="Mission title"
                placeholder="Add dashboard mission creation"
                value={form.title}
                onChange={(event) => updateField('title', event.currentTarget.value)}
                maxLength={160}
                required
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <Textarea
                label="Objective"
                placeholder="Describe the result the agent team must deliver."
                value={form.objective}
                onChange={(event) => updateField('objective', event.currentTarget.value)}
                minRows={4}
                maxLength={5_000}
                autosize
                required
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput
                label="Repository"
                placeholder="LihSheng/ops-room"
                leftSection={<IconGitBranch size={16} />}
                value={form.repository}
                onChange={(event) => updateField('repository', event.currentTarget.value)}
                required
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput
                label="Starting branch"
                value={form.startingBranch}
                onChange={(event) => updateField('startingBranch', event.currentTarget.value)}
                required
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <TextInput
                label="Exact starting SHA"
                description="Use the full 40-character commit SHA, not a branch name or abbreviated SHA."
                placeholder="0123456789abcdef0123456789abcdef01234567"
                value={form.startingSha}
                onChange={(event) => updateField('startingSha', event.currentTarget.value)}
                ff="monospace"
                maxLength={40}
                required
              />
            </Grid.Col>
          </Grid>

          <Divider />

          <Box>
            <Text fw={700}>Workflow policy</Text>
            <Text size="sm" c="dimmed">The V2 MVP keeps workflow type, stage ownership, and Berlin approval deterministic.</Text>
          </Box>

          <Paper withBorder p="md" bg="gray.0">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <Stack gap={5}>
                <Group gap={6}><Badge variant="light">feature-development</Badge><Badge variant="light" color="teal">Berlin approval required</Badge></Group>
                <Text size="sm">Professor implementation → Tokyo tests → Professor integration → Berlin review</Text>
              </Stack>
              <IconShieldCheck size={22} />
            </Group>
          </Paper>

          <Grid>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <NumberInput
                label="Maximum iterations"
                min={1}
                max={20}
                value={form.maxIterations}
                onChange={(value) => updateField('maxIterations', typeof value === 'number' ? value : 3)}
                required
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <Select
                label="Priority"
                value={form.priority}
                onChange={(value) => updateField('priority', (value || 'normal') as MissionPriority)}
                data={[
                  { label: 'Low', value: 'low' },
                  { label: 'Normal', value: 'normal' },
                  { label: 'High', value: 'high' },
                  { label: 'Urgent', value: 'urgent' },
                ]}
                allowDeselect={false}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <TextInput
                label="GitHub issue"
                placeholder="68"
                inputMode="numeric"
                value={form.githubIssue}
                onChange={(event) => updateField('githubIssue', event.currentTarget.value)}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput
                label="Deadline"
                type="datetime-local"
                value={form.deadline}
                onChange={(event) => updateField('deadline', event.currentTarget.value)}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput
                label="Required capabilities"
                description="Comma-separated bounded capability IDs."
                placeholder="implementation, test-development, pull-request-review"
                value={form.requiredCapabilities}
                onChange={(event) => updateField('requiredCapabilities', event.currentTarget.value)}
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <Textarea
                label="Reference documents"
                description="One safe identifier or URL per line. Local file paths are rejected."
                placeholder="docs/OPS-012C-MISSIONS.md"
                value={form.referenceDocuments}
                onChange={(event) => updateField('referenceDocuments', event.currentTarget.value)}
                minRows={2}
                autosize
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <Textarea
                label="Supporting context"
                placeholder="Add bounded context that helps the agents understand the mission."
                value={form.supportingContext}
                onChange={(event) => updateField('supportingContext', event.currentTarget.value)}
                maxLength={5_000}
                minRows={3}
                autosize
              />
            </Grid.Col>
          </Grid>

          <Divider />

          <Textarea
            label="Operator reason"
            description="This reason is written to the actor-attributed audit event."
            placeholder="Create the planned mission after reviewing its repository and workflow policy."
            value={form.reason}
            onChange={(event) => updateField('reason', event.currentTarget.value)}
            maxLength={500}
            minRows={2}
            required
          />

          <Paper withBorder p="sm">
            <Group justify="space-between" wrap="nowrap">
              <Box style={{ minWidth: 0 }}>
                <Text size="xs" c="dimmed">Idempotency key</Text>
                <Text size="xs" ff="monospace" lineClamp={1}>{requestKey}</Text>
              </Box>
              <IconCheck size={18} />
            </Group>
          </Paper>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
            <Button type="submit" loading={mutation.isPending} disabled={!csrfToken}>Create planned mission</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
