export const ErrorType = {
  CONFIG: 'config_error',
  INVALID_INPUT: 'invalid_input',
  INVALID_QUESTION: 'invalid_question',
  FILE_NOT_FOUND: 'file_not_found',
  FILE_UNREADABLE: 'file_unreadable',
  BINARY_FILE: 'binary_file',
  SECRET_FILE: 'secret_file',
  FILE_TOO_LARGE: 'file_too_large',
  TOO_MANY_FILES: 'too_many_files',
  MISSING_ARTIFACT: 'missing_artifact',
  SESSION: 'session_error',
  SKILL_CONFLICT: 'skill_conflict',
  CONTEXT_TOO_LARGE: 'context_too_large',
  AUTH: 'auth_error',
  PAYMENT_REQUIRED: 'payment_required',
  INVALID_REQUEST: 'invalid_request',
  RATE_LIMITED: 'rate_limited',
  OVERLOADED: 'overloaded',
  PROVIDER: 'provider_error',
  TIMEOUT: 'timeout',
  NETWORK: 'network_error',
  INVALID_RESPONSE: 'invalid_response',
  CANCELLED: 'cancelled',
  INTERNAL: 'internal_error',
};

export class JevAnswersError extends Error {
  /**
   * @param {string} type one of ErrorType
   * @param {string} message
   * @param {object} [details]
   */
  constructor(type, message, details) {
    super(message);
    this.name = 'JevAnswersError';
    this.type = type;
    this.details = details;
  }
}

export function toErrorRecord(err, stage) {
  const known = err instanceof JevAnswersError;
  const record = {
    stage,
    type: known ? err.type : ErrorType.INTERNAL,
    message: err?.message ?? String(err),
  };
  if (known && err.details !== undefined) record.details = err.details;
  return record;
}

/**
 * Remove the API key and any credential-looking bearer token from an error record (message and details),
 * whatever the source: provider bodies, fetch exceptions, header errors.
 */
export function redactSecrets(record, apiKey) {
  let text = JSON.stringify(record);
  const secrets = [apiKey, apiKey?.trim()].filter((s) => typeof s === 'string' && s.length >= 4);
  for (const secret of new Set(secrets)) {
    text = text.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
  }
  // Only tokens that look like credentials, so "Invalid Bearer token" stays readable.
  text = text.replace(/Bearer\s+([^\s"\\]+)/gi, (match, token) =>
    token.length >= 12 && /[0-9_-]/.test(token) ? '[redacted]' : match);
  return JSON.parse(text);
}
