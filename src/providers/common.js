import { ErrorType } from '../errors.js';

/** Map an HTTP status to a generic error type. Providers refine this. */
export function classifyStatus(status) {
  if (status === 401 || status === 403) return ErrorType.AUTH;
  if (status === 402) return ErrorType.PAYMENT_REQUIRED;
  if (status === 413) return ErrorType.CONTEXT_TOO_LARGE;
  if (status === 400 || status === 422) return ErrorType.INVALID_REQUEST;
  if (status === 429) return ErrorType.RATE_LIMITED;
  if (status === 529) return ErrorType.OVERLOADED;
  return ErrorType.PROVIDER;
}

/** Pull a human-readable message out of an error body of unknown shape. */
export function messageFromBody(body) {
  if (typeof body === 'string') return body.slice(0, 300) || undefined;
  if (!body || typeof body !== 'object') return undefined;
  const candidate = body.error?.message ?? body.message ?? body.detail ?? body.error;
  if (typeof candidate === 'string') return candidate.slice(0, 300);
  if (candidate !== undefined) return JSON.stringify(candidate).slice(0, 300);
  return undefined;
}

export const TOO_LARGE_PATTERN = /too (large|long|many)|token|context (length|window)|exceed/i;
