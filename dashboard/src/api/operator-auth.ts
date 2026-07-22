export interface OperatorSessionActor {
  actor_type: string;
  actor_id: string;
  actor_display_name: string;
  auth_method: string;
}

export interface OperatorSession {
  session_id: string;
  actor: OperatorSessionActor;
  roles: string[];
  created_at: string;
  expires_at: string;
}

export interface OperatorSessionResponse {
  session: OperatorSession;
  csrf_token: string;
}

export class OperatorAuthError extends Error {
  readonly status: number;
  readonly errorCode: string | null;

  constructor(status: number, message: string, errorCode: string | null = null) {
    super(message);
    this.name = 'OperatorAuthError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  });

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorAuthError(
      response.status,
      String(payload.error || response.statusText || 'Authentication request failed'),
      payload.error_code ? String(payload.error_code) : null,
    );
  }
  return payload as T;
}

export const operatorAuthApi = {
  readSession: () => requestJson<OperatorSessionResponse>('/api/auth/session'),
  createSession: (operatorToken: string) => requestJson<OperatorSessionResponse>('/api/auth/session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${operatorToken}`,
    },
  }),
  revokeSession: (csrfToken: string) => requestJson<{ ok: true; session_id: string }>('/api/auth/session', {
    method: 'DELETE',
    headers: {
      'X-Ops-Room-CSRF': csrfToken,
    },
  }),
};
