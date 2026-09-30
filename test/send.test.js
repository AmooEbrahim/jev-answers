import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseRetryAfter, send } from '../src/stages/send.js';
import { createSession, readJson, writeJson } from '../src/session.js';
import { fakeProvider, OK_RESPONSE, QUESTIONS, reply, tempDir, testConfig } from './helpers.js';

const REQUEST = { model: 'jev-latest', state: { context: 'x' }, questions: QUESTIONS };

async function prepared(t, handler, overrides = {}) {
  const dir = await tempDir(t);
  const fake = await fakeProvider(t, handler);
  const config = testConfig(dir, { base_url: fake.url, max_retries: 2, ...overrides });
  const session = await createSession(config);
  await writeJson(session, 'request.json', REQUEST);
  return { fake, config, session };
}

const fast = { backoffBaseMs: 1 };
const rejectsWith = (promise, type) => assert.rejects(promise, (e) => e.type === type);

test('success: sends the exact request with auth and stores the raw response', async (t) => {
  const { fake, config, session } = await prepared(t);
  const response = await send(session, config, fast);
  assert.deepEqual(response, OK_RESPONSE);
  assert.deepEqual(await readJson(session, 'response.json'), OK_RESPONSE);
  const [req] = fake.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/v1/systemone');
  assert.equal(req.headers.authorization, 'Bearer test-key-1234567890');
  assert.deepEqual(req.body, REQUEST);
  const meta = await readJson(session, 'meta.json');
  assert.deepEqual(meta.http, { attempts: 1, status: 200, request_id: 'req-1' });
});

test('base_url is used as the full endpoint URL', async (t) => {
  const { fake, config, session } = await prepared(t);
  await send(session, { ...config, base_url: `${fake.origin}/gateway/decisions` }, fast);
  assert.equal(fake.requests[0].url, '/gateway/decisions');
});

test('openrouter reads the request id from the body', async (t) => {
  const { config, session } = await prepared(t, (req, res) => reply(res, 200, { ...OK_RESPONSE, id: 'gen-dec-1' }), { provider: 'openrouter' });
  await send(session, config, fast);
  assert.equal((await readJson(session, 'meta.json')).http.request_id, 'gen-dec-1');
});

test('529 is retried and reported as overloaded', async (t) => {
  const { fake, config, session } = await prepared(t, (req, res) => reply(res, 529, 'busy'), { max_retries: 1 });
  await rejectsWith(send(session, config, fast), 'overloaded');
  assert.equal(fake.requests.length, 2);
});

test('429 with Retry-After is retried, then succeeds', async (t) => {
  const { fake, config, session } = await prepared(t, (req, res, body, n) =>
    n === 1 ? reply(res, 429, { detail: 'slow down' }, { 'retry-after': '0' }) : reply(res, 200, OK_RESPONSE));
  await send(session, config, fast);
  assert.equal(fake.requests.length, 2);
  assert.equal((await readJson(session, 'meta.json')).http.attempts, 2);
});

test('Retry-After acts as a minimum delay', async (t) => {
  const { config, session } = await prepared(t, (req, res, body, n) =>
    n === 1 ? reply(res, 429, {}, { 'retry-after': '1' }) : reply(res, 200, OK_RESPONSE));
  const started = Date.now();
  await send(session, config, fast);
  assert.ok(Date.now() - started >= 900);
});

test('401 is not retried and is classified as auth_error', async (t) => {
  const { fake, config, session } = await prepared(t, (req, res) => reply(res, 401, { detail: 'bad key' }));
  await assert.rejects(send(session, config, fast), (e) => {
    assert.equal(e.type, 'auth_error');
    assert.equal(e.details.status, 401);
    assert.deepEqual(e.details.body, { detail: 'bad key' });
    return true;
  });
  assert.equal(fake.requests.length, 1);
  await assert.rejects(fs.access(path.join(session.dir, 'response.json')));
});

test('status to error type mapping, never retried for client errors', async (t) => {
  for (const [status, type] of [[402, 'payment_required'], [403, 'auth_error'], [404, 'provider_error'], [413, 'context_too_large'], [400, 'invalid_request'], [422, 'invalid_request']]) {
    const { fake, config, session } = await prepared(t, (req, res) => reply(res, status, { error: { message: 'no' } }));
    await rejectsWith(send(session, config, fast), type);
    assert.equal(fake.requests.length, 1, `status ${status}`);
  }
});

test('5xx retries are exhausted, then provider_error', async (t) => {
  const { fake, config, session } = await prepared(t, (req, res) => reply(res, 503, 'upstream down'));
  await assert.rejects(send(session, config, fast), (e) => e.type === 'provider_error' && e.details.attempts === 3 && e.details.body === 'upstream down');
  assert.equal(fake.requests.length, 3);
});

test('429 after retries is rate_limited', async (t) => {
  const { config, session } = await prepared(t, (req, res) => reply(res, 429, {}), { max_retries: 1 });
  await rejectsWith(send(session, config, fast), 'rate_limited');
});

test('openrouter: 400 about tokens is context_too_large', async (t) => {
  const { config, session } = await prepared(t, (req, res) => reply(res, 400, { error: { code: 400, message: 'Too many tokens' } }), { provider: 'openrouter' });
  await rejectsWith(send(session, config, fast), 'context_too_large');
});

test('timeout', async (t) => {
  const { config, session } = await prepared(t, () => { /* never answer */ }, { timeout_ms: 50, max_retries: 0 });
  await rejectsWith(send(session, config, fast), 'timeout');
});

test('cancellation', async (t) => {
  const { config, session } = await prepared(t, () => { /* never answer */ });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await rejectsWith(send(session, config, { ...fast, signal: controller.signal }), 'cancelled');
});

test('network error is retried then reported', async (t) => {
  const dir = await tempDir(t);
  const config = testConfig(dir, { base_url: 'http://127.0.0.1:1', max_retries: 1 });
  const session = await createSession(config);
  await writeJson(session, 'request.json', REQUEST);
  await assert.rejects(send(session, config, fast), (e) => e.type === 'network_error' && e.details.attempts === 2);
});

test('2xx with a non-JSON body is invalid_response', async (t) => {
  const { config, session } = await prepared(t, (req, res) => { res.writeHead(200); res.end('<html>hi</html>'); });
  await assert.rejects(send(session, config, fast), (e) => e.type === 'invalid_response' && e.details.body.includes('<html>'));
});

test('missing key and placeholder key fail before any request', async (t) => {
  const { fake, config, session } = await prepared(t);
  await assert.rejects(send(session, { ...config, api_key: undefined }, fast), (e) => e.type === 'config_error');
  await assert.rejects(send(session, { ...config, api_key: '${KEY}' }, fast), (e) => e.type === 'config_error');
  assert.equal(fake.requests.length, 0);
});

test('parseRetryAfter handles seconds and dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(undefined), 0);
  assert.equal(parseRetryAfter('nonsense'), 0);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now), 0);
});
