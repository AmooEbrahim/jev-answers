import { checkBaseUrl, requireApiKey } from '../config.js';
import { ErrorType, JevAnswersError } from '../errors.js';
import { getProvider } from '../providers/index.js';
import { readJson, updateMeta, writeJson } from '../session.js';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 524, 529]);
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_BODY_CHARS = 8 * 1024;

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - now);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const cancelled = () => new JevAnswersError(ErrorType.CANCELLED, 'The request was cancelled.');

/** Keep small JSON bodies as they are; cut anything bigger down to text. */
export function limitBody(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text.length <= MAX_BODY_CHARS) return { body };
  return { body: text.slice(0, MAX_BODY_CHARS), body_truncated: true };
}

/**
 * One HTTP attempt. Returns {response, text}, {failure} (worth retrying), or throws
 * for failures that would repeat identically.
 */
async function attempt(url, init, config, signal) {
  const timeout = AbortSignal.timeout(config.timeout_ms);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error', // never forward the API key to another host
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return { response, text: await response.text() };
  } catch (err) {
    if (signal?.aborted) throw cancelled();
    if (timeout.aborted) {
      return { failure: new JevAnswersError(ErrorType.TIMEOUT, `No response within ${config.timeout_ms} ms.`) };
    }
    const reason = err.cause?.code ?? err.cause?.message ?? err.message;
    if (/redirect/i.test(String(err.cause?.message ?? err.message))) {
      throw new JevAnswersError(
        ErrorType.PROVIDER,
        'The endpoint answered with a redirect, which is not followed (the API key must not be sent to another host). Set base_url to the final URL.',
      );
    }
    return { failure: new JevAnswersError(ErrorType.NETWORK, `Network error: ${reason}`) };
  }
}

function tryParse(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: undefined };
  }
}

/**
 * Stage 3: POST request.json to the provider, write response.json.
 * @param {{signal?: AbortSignal, backoffBaseMs?: number}} [opts]
 */
export async function send(session, config, { signal, backoffBaseMs = 1000 } = {}) {
  const provider = getProvider(config.provider);
  const apiKey = requireApiKey(config);
  const url = checkBaseUrl(config.base_url).toString();
  const body = JSON.stringify(await readJson(session, 'request.json'));
  const init = { method: 'POST', headers: provider.headers(apiKey), body };

  for (let attemptNo = 1; ; attemptNo++) {
    const { response, text, failure } = await attempt(url, init, config, signal);
    const http = { attempts: attemptNo };
    let error = failure;
    let retryAfter = 0;

    if (response) {
      http.status = response.status;
      const parsed = tryParse(text);
      http.request_id = provider.requestId(response.headers, parsed.value);

      if (response.ok) {
        await updateMeta(session, { http });
        if (parsed.value === undefined) {
          throw new JevAnswersError(ErrorType.INVALID_RESPONSE, 'The provider answered 2xx but the body is not JSON.', {
            status: response.status,
            ...limitBody(text),
          });
        }
        await writeJson(session, 'response.json', parsed.value);
        return parsed.value;
      }
      const errorBody = parsed.value ?? text;
      const { type, message } = provider.classifyError(response.status, errorBody);
      error = new JevAnswersError(type, message, { status: response.status, ...limitBody(errorBody), attempts: attemptNo });
      retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    }
    await updateMeta(session, { http }); // describes the last attempt only

    const retryable = !response || RETRYABLE_STATUS.has(response.status);
    if (!retryable) throw error;
    if (retryAfter > MAX_RETRY_AFTER_MS) {
      error.details = { ...error.details, retry_after_seconds: Math.ceil(retryAfter / 1000) };
      throw error;
    }
    if (attemptNo > config.max_retries) {
      error.details = { ...error.details, attempts: attemptNo };
      throw error;
    }
    const backoff = Math.min(MAX_BACKOFF_MS, backoffBaseMs * 2 ** (attemptNo - 1));
    try {
      await sleep(Math.max(backoff, retryAfter), signal);
    } catch {
      throw cancelled();
    }
  }
}
