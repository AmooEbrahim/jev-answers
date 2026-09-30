import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ask, resend } from '../src/pipeline.js';
import { listSessions, pruneSessions, readJson, resolveSession, slugify } from '../src/session.js';
import { fakeProvider, OK_RESPONSE, QUESTIONS, reply, tempDir, testConfig, writeTree } from './helpers.js';

async function env(t, handler, overrides = {}) {
  const dir = await tempDir(t);
  const fake = await fakeProvider(t, handler);
  const project = path.join(dir, 'project');
  await writeTree(project, { 'a.js': 'const a = 1;\n' });
  const config = testConfig(dir, { base_url: fake.url, ...overrides });
  return { dir, fake, project, config, opts: { config, backoffBaseMs: 1 } };
}

const exists = (dir, name) => fs.access(path.join(dir, name)).then(() => true, () => false);

test('successful run writes every artifact and returns the raw response', async (t) => {
  const { fake, project, opts } = await env(t);
  const input = { base_dir: project, files: ['a.js'], questions: QUESTIONS, label: 'My Review!' };
  const stages = [];
  const result = await ask(input, { ...opts, onProgress: (stage, step, total) => stages.push([stage, step, total]) });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.response, OK_RESPONSE);
  assert.deepEqual(stages, [['collect', 1, 3], ['build', 2, 3], ['send', 3, 3]]);
  assert.match(path.basename(result.session), /^\d{8}-\d{6}-my-review-[0-9a-f]{4}$/);
  for (const name of ['input.json', 'manifest.json', 'request.json', 'response.json', 'meta.json', 'inputs/a.js']) {
    assert.ok(await exists(result.session, name), name);
  }
  assert.equal(await exists(result.session, 'error.json'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.session, 'input.json'), 'utf8')), input);
  assert.equal(fake.requests[0].body.state.files[0].content, 'const a = 1;\n');
  const meta = await readJson({ dir: result.session }, 'meta.json');
  assert.equal(meta.status, 'ok');
  assert.equal(meta.label, 'My Review!');
  assert.equal(meta.provider, 'typesafe');
  assert.match(meta.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.deepEqual(Object.keys(meta.stages), ['collect', 'build', 'send']);
  assert.ok(meta.estimate.total_tokens > 0);
  assert.ok(!JSON.stringify(await fs.readFile(path.join(result.session, 'request.json'), 'utf8')).includes('test-key'));
});

test('latest symlink points at the newest session', async (t) => {
  const { config, opts } = await env(t);
  const result = await ask({ context: 'x', questions: QUESTIONS }, opts);
  const link = await fs.readlink(path.join(config.home, 'sessions', 'latest'));
  assert.equal(link, path.basename(result.session));
  assert.equal((await resolveSession(config, 'latest')).dir, result.session);
});

test('collect failure: no request.json, error.json recorded', async (t) => {
  const { opts } = await env(t);
  const result = await ask({ files: ['/nope/missing.js'], questions: QUESTIONS }, opts);
  assert.equal(result.status, 'error');
  assert.equal(result.error.stage, 'collect');
  assert.equal(result.error.type, 'file_not_found');
  assert.equal(await exists(result.session, 'request.json'), false);
  assert.deepEqual(await readJson({ dir: result.session }, 'error.json'), result.error);
  assert.equal((await readJson({ dir: result.session }, 'meta.json')).status, 'error');
  assert.ok(await exists(result.session, 'input.json'));
});

test('build failure: manifest exists, request.json does not', async (t) => {
  const { opts } = await env(t);
  const result = await ask({ context: 'x', questions: { a: { type: 'bad' } } }, opts);
  assert.equal(result.error.stage, 'build');
  assert.equal(result.error.type, 'invalid_question');
  assert.ok(await exists(result.session, 'manifest.json'));
  assert.equal(await exists(result.session, 'request.json'), false);
});

test('context_too_large fails at build and nothing is sent', async (t) => {
  const { fake, opts } = await env(t, undefined, { max_input_tokens: 10 });
  const result = await ask({ context: 'x'.repeat(500), questions: QUESTIONS }, opts);
  assert.equal(result.error.stage, 'build');
  assert.equal(result.error.type, 'context_too_large');
  assert.equal(fake.requests.length, 0);
});

test('send failure keeps request.json, has no response.json and stores the provider body', async (t) => {
  const { opts } = await env(t, (req, res) => reply(res, 401, { detail: 'nope' }));
  const result = await ask({ context: 'x', questions: QUESTIONS }, opts);
  assert.equal(result.error.stage, 'send');
  assert.equal(result.error.type, 'auth_error');
  assert.ok(await exists(result.session, 'request.json'));
  assert.equal(await exists(result.session, 'response.json'), false);
  const saved = await readJson({ dir: result.session }, 'error.json');
  assert.deepEqual(saved.details.body, { detail: 'nope' });
});

test('missing API key fails at the send stage after collect and build were recorded', async (t) => {
  const { opts, config } = await env(t);
  const result = await ask({ context: 'x', questions: QUESTIONS }, { ...opts, config: { ...config, api_key: undefined } });
  assert.equal(result.error.stage, 'send');
  assert.equal(result.error.type, 'config_error');
  assert.ok(await exists(result.session, 'request.json'));
});

test('non-object input and bad model are reported, never thrown', async (t) => {
  const { opts } = await env(t);
  assert.equal((await ask('nope', opts)).error.type, 'invalid_input');
  assert.equal((await ask(null, opts)).status, 'error');
  assert.equal((await ask({ context: 'x', questions: QUESTIONS, model: 5 }, opts)).error.type, 'invalid_input');
});

test('per-call model reaches the wire', async (t) => {
  const { fake, opts } = await env(t);
  await ask({ context: 'x', questions: QUESTIONS, model: 'jev-1.13.0' }, opts);
  assert.equal(fake.requests[0].body.model, 'jev-1.13.0');
});

test('cancelling aborts the in-flight request', async (t) => {
  const { opts } = await env(t, () => {});
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await ask({ context: 'x', questions: QUESTIONS }, { ...opts, signal: controller.signal });
  assert.equal(result.error.type, 'cancelled');
});

test('resend creates a new session and only sends', async (t) => {
  const { fake, config, opts } = await env(t, (req, res, body, n) => (n === 1 ? reply(res, 401, {}) : reply(res, 200, OK_RESPONSE)));
  const first = await ask({ context: 'x', questions: QUESTIONS, label: 'again' }, opts);
  assert.equal(first.status, 'error');
  const second = await resend(await resolveSession(config, 'latest'), opts);
  assert.equal(second.status, 'ok');
  assert.notEqual(second.session, first.session);
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(fake.requests[1].body, fake.requests[0].body);
  const meta = await readJson({ dir: second.session }, 'meta.json');
  assert.equal(meta.resent_from, path.basename(first.session));
  assert.equal(meta.label, 'again');
  assert.deepEqual(Object.keys(meta.stages), ['send']);
  assert.equal((await ask({ files: ['/nope'], questions: QUESTIONS }, opts)).status, 'error');
  const noRequest = await resend(await resolveSession(config, 'latest'), opts);
  assert.equal(noRequest.error.type, 'missing_artifact');
});

test('list, resolve and prune', async (t) => {
  const { config, opts } = await env(t);
  const a = await ask({ context: 'x', questions: QUESTIONS, label: 'one' }, opts);
  const b = await ask({ context: 'x', questions: QUESTIONS, label: 'two' }, opts);
  const sessions = await listSessions(config);
  assert.equal(sessions.length, 2);
  assert.ok(sessions[0].id >= sessions[1].id);
  assert.equal((await resolveSession(config, 'one')).dir, a.session);
  await assert.rejects(resolveSession(config, 'zzz'), (e) => e.type === 'session_error');

  const future = Date.now() + 40 * 86_400_000;
  assert.deepEqual(await pruneSessions(config, { olderThanDays: 30, dryRun: true }), []);
  assert.equal((await pruneSessions(config, { olderThanDays: 30, now: future, dryRun: true })).length, 2);
  assert.equal((await pruneSessions(config, { olderThanDays: 30, now: future, keep: path.basename(b.session) })).length, 1);
  assert.equal((await listSessions(config)).length, 1);
});

test('retention_days prunes old sessions when a new one is created', async (t) => {
  const { config, opts } = await env(t, undefined, { retention_days: 1 });
  const old = await ask({ context: 'x', questions: QUESTIONS }, opts);
  const metaFile = path.join(old.session, 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  meta.created_at = '2020-01-01T00:00:00+00:00';
  await fs.writeFile(metaFile, JSON.stringify(meta));
  await ask({ context: 'x', questions: QUESTIONS }, opts);
  const remaining = await listSessions(config);
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].dir, old.session);
});

test('slugify', () => {
  assert.equal(slugify('Payment Review #3'), 'payment-review-3');
  assert.equal(slugify(''), '');
  assert.equal(slugify(undefined), '');
  assert.ok(slugify('a'.repeat(100)).length <= 40);
  assert.equal(slugify('ÄÖ---x--'), 'x');
});
