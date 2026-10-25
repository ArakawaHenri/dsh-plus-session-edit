export class SessionEditError extends Error {
  constructor(code, message, data = {}, options) {
    super(message, options);
    this.name = 'SessionEditError';
    this.code = code.startsWith('session-edit/') ? code : `session-edit/${code}`;
    this.data = data;
  }
}

export function fail(code, message, data) {
  throw new SessionEditError(code, message, data);
}

const KNOWN_HOST_ERRORS = {
  SESSION_QUERY_SESSION_NOT_FOUND: ['not-found', 'The session no longer exists.'],
  SESSION_QUERY_CORRUPT_SESSION: ['invalid-history', 'The session history could not be validated.'],
  SESSION_QUERY_SOURCE_CONFLICT: ['session-changed', 'The session changed. Refresh and try again.'],
  'session/writer-held': ['writer-held', 'Another process owns this session.'],
  'session/not-found': ['not-found', 'The session no longer exists.'],
  'session/migration-required': ['migration-required', 'Open the session in DSH to migrate it first.'],
};

export function publicFailure(error) {
  if (error instanceof SessionEditError || String(error?.code).startsWith('session-edit/')) {
    return { code: error.code, message: error.message };
  }
  const mapped = KNOWN_HOST_ERRORS[error?.code];
  if (mapped) {
    return { code: `session-edit/${mapped[0]}`, message: mapped[1] };
  }
  if (error?.name === 'SessionAlreadyOwnedError') {
    return { code: 'session-edit/writer-held', message: 'Another process owns this session.' };
  }
  return { code: 'session-edit/host-error', message: 'The host could not complete this action.' };
}
