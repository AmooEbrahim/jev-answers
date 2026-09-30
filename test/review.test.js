import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { checkBaseUrl, loadConfig, maskKey, redact, redactUrl, requireApiKey } from '../src/config.js';
import { redactSecrets } from '../src/errors.js';
import { tool } from '../src/mcp/tool.js';
import { ask } from '../src/pipeline.js';
import { createSession, readJson, writeJson } from '../src/session.js';
import { collect } from '../src/stages/collect.js';
import { globToRegExp } from '../src/stages/files.js';
import { isSecretFile } from '../src/stages/secrets.js';
import { limitBody, send } from '../src/stages/send.js';
import { estimateTokens } from '../src/tokens.js';
import { fakeProvider, isolatedEnv, OK_RESPONSE, QUESTIONS, reply, runCli, tempDir, testConfig, writeTree } from './helpers.js';

const KEY = 'sk-test-abcdefghijklmnop';
const fast = { backoffBaseMs: 1 };

async function project(t, tree, overrides = {}) {
  const dir = await tempDir(t);
  const root = path.join(dir, 'p');
  await writeTree(root, tree);
  const config = testConfig(dir, overrides);
  const session = await createSession(config);
  return { dir, root, config, session };
}

async function sendEnv(t, handler, overrides = {}) {
  const dir = await tempDir(t);
  const fake = await fakeProvider(t, handler);
  const config = testConfig(dir, { base_url: fake.url, max_retries: 1, ...overrides });
  const session = await createSession(config);
  await writeJson(session, 'request.json', { model: 'm', state: {}, questions: QUESTIONS });
  return { fake, config, session, dir };
}

// 1. key leaks
test('a key with a newline is rejected without being echoed', async (t) => {
  const { config, session } = await sendEnv(t);
  await assert.rejects(send(session, { ...config, api_key: 'sk-abc\nTAIL' }, fast), (e) => {
    assert.equal(e.type, 'config_error');
    assert.ok(!e.message.includes('sk-abc') && !e.message.includes('TAIL'));
    return true;
  });
  assert.throws(() => requireApiKey({ provider: 'typesafe', api_key: 'has space' }), /spaces/);
  assert.throws(() => requireApiKey({ provider: 'typesafe', api_key: 'kéy' }), /non-ASCII/);
});

test('the key and bearer tokens are redacted from returned and stored errors', async (t) => {
  const dir = await tempDir(t);
  const fake = await fakeProvider(t, (req, res) => reply(res, 400, { error: { message: `bad ${KEY} and Bearer ${KEY}`, echo: req.headers.authorization } }));
  const config = testConfig(dir, { base_url: fake.url, api_key: KEY });
  const result = await ask({ context: 'x', questions: QUESTIONS }, { config });
  const returned = JSON.stringify(result);
  const stored = await fs.readFile(path.join(result.session, 'error.json'), 'utf8');
  for (const text of [returned, stored]) {
    assert.ok(!text.includes(KEY));
    assert.ok(!/Bearer\s+(?!\[redacted\])\S/.test(text));
    assert.ok(text.includes('[redacted]'));
  }
  assert.deepEqual(redactSecrets({ a: ['Bearer abc123def456-xyz'] }, undefined), { a: ['[redacted]'] });
  assert.deepEqual(redactSecrets({ a: ['Invalid Bearer token'] }, undefined), { a: ['Invalid Bearer token'] });
  assert.deepEqual(redactSecrets({ a: ['bad key sk-test-abcdefghijklmnop'] }, KEY), { a: ['bad key [redacted]'] });
});

// 2. collect
test('an explicit secret file cannot hide behind an earlier glob skip', async (t) => {
  const { root, config, session } = await project(t, { '.env': 'A=1', 'a.txt': 'a' });
  await assert.rejects(collect(session, { base_dir: root, files: ['.e*', '.env'] }, config), (e) => e.type === 'secret_file');
});

test('nothing collected and no context is invalid_input, never an empty state', async (t) => {
  const { root, config, session } = await project(t, { '.env': 'A=1' });
  await assert.rejects(collect(session, { base_dir: root, files: ['.e*'] }, config), (e) => {
    assert.equal(e.type, 'invalid_input');
    assert.match(e.message, /all 1 candidate/);
    assert.match(e.message, /secret file/);
    return true;
  });
  const ok = await collect(session, { base_dir: root, files: ['.e*'], context: 'still fine' }, config);
  assert.equal(ok.files.length, 0);
});

test('a duplicate that carries a label lends it to the stored entry', async (t) => {
  const { root, config, session } = await project(t, { 'a.txt': 'a', 'b.txt': 'b' });
  const manifest = await collect(session, { base_dir: root, files: ['*.txt', { path: 'a.txt', label: 'LBL' }] }, config);
  assert.equal(manifest.files.find((f) => f.display_path === 'a.txt').label, 'LBL');
  assert.equal(manifest.files.find((f) => f.display_path === 'b.txt').label, undefined);
});

// 3. symlinks and globbing
test('symlinks are skipped in expansion and secret targets are caught when named', async (t) => {
  const { dir, root, config, session } = await project(t, { '.env': 'A=1', 'ok.txt': 'ok', 'sub/x.txt': 'x' });
  await writeTree(dir, { 'outside/secret.txt': 'outside' });
  await fs.symlink('.env', path.join(root, 'config.txt'));
  await fs.symlink(path.join(dir, 'outside'), path.join(root, 'linkdir'));

  for (const files of [['*.txt', 'linkdir/**'], ['.'], ['**/*']]) {
    const manifest = await collect(session, { base_dir: root, files }, config);
    const names = manifest.files.map((f) => f.display_path);
    assert.ok(!names.includes('config.txt'), JSON.stringify(files));
    assert.ok(!names.some((n) => n.startsWith('linkdir')), JSON.stringify(files));
    assert.ok(!manifest.files.some((f) => f.source.includes('outside')));
  }
  const manifest = await collect(session, { base_dir: root, files: ['.'] }, config);
  assert.ok(manifest.skipped.some((s) => s.source.endsWith('config.txt') && s.reason === 'symlink'));
  assert.ok(manifest.skipped.some((s) => s.source.endsWith('linkdir') && s.reason === 'symlink'));
  await assert.rejects(collect(session, { base_dir: root, files: ['config.txt'] }, config), (e) => e.type === 'secret_file');
});

test('hidden entries are skipped in glob and directory expansion unless the pattern names them', async (t) => {
  const { root, config, session } = await project(t, {
    '.hidden.txt': 'h', 'v.txt': 'v', 'd/.also.txt': 'a', 'd/ok.txt': 'o',
    '.github/w/ci.yml': 'ci', '.cache/deep/x.txt': 'x', 'src/.eslintrc.json': '{}',
  });
  const names = (m) => m.files.map((f) => f.display_path).sort();
  const run = (files) => collect(session, { base_dir: root, files }, config);

  const viaGlob = await run(['**/*.txt']);
  assert.deepEqual(names(viaGlob), ['d/ok.txt', 'v.txt']);
  assert.deepEqual(names(await run(['.'])), ['d/ok.txt', 'v.txt']);
  const dir = await run(['.']);
  assert.ok(dir.skipped.some((s) => s.source.endsWith('.cache') && s.reason === 'hidden'));
  assert.ok(!dir.skipped.some((s) => s.source.includes('.cache/')), 'hidden dir recorded once, not its contents');

  assert.deepEqual(names(await run(['.github/**/*.yml'])), ['.github/w/ci.yml']);
  assert.deepEqual(names(await run(['**/.eslintrc*'])), ['src/.eslintrc.json']);
  assert.deepEqual(names(await run(['.*.txt'])), ['.hidden.txt']);
  assert.deepEqual(names(await run(['.github'])), ['.github/w/ci.yml']); // an explicitly named directory is entered
  assert.deepEqual(names(await run(['.hidden.txt'])), ['.hidden.txt']); // explicit files are always allowed
});

test('a trailing slash means the directory itself', async (t) => {
  const { root, config, session } = await project(t, { 'src/a.js': 'a', 'src/deep/b.js': 'b', 'other.js': 'o' });
  const names = async (files) => (await collect(session, { base_dir: root, files }, config)).files.map((f) => f.display_path).sort();
  assert.deepEqual(await names(['src/']), ['src/a.js', 'src/deep/b.js']);
  assert.deepEqual(await names(['src/**/']), ['src/a.js', 'src/deep/b.js']);
});

test('unreadable directories are skipped, an unreadable explicit file still errors', { skip: process.getuid?.() === 0 }, async (t) => {
  const { root, config, session } = await project(t, { 'ok/a.txt': 'a', 'locked/b.txt': 'b', 'c.txt': 'c' });
  await fs.chmod(path.join(root, 'locked'), 0o000);
  await fs.chmod(path.join(root, 'c.txt'), 0o000);
  try {
    const manifest = await collect(session, { base_dir: root, files: ['.', '**/*.txt'] }, config);
    assert.deepEqual(manifest.files.map((f) => f.display_path), ['ok/a.txt']);
    assert.ok(manifest.skipped.some((s) => s.source.endsWith('locked') && s.reason === 'unreadable'));
    await assert.rejects(collect(session, { base_dir: root, files: ['c.txt'] }, config), (e) => e.type === 'file_unreadable');
  } finally {
    // Restore permissions so the temp directory can be removed.
    await fs.chmod(path.join(root, 'locked'), 0o755);
    await fs.chmod(path.join(root, 'c.txt'), 0o644);
  }
});

test('globs without ** do not read deeper than the pattern, and huge walks are refused', async (t) => {
  const { root, config, session } = await project(t, { 'a.md': 'a', 'x/y/z/deep.md': 'd' });
  const shallow = await collect(session, { base_dir: root, files: ['*.md'] }, config);
  assert.deepEqual(shallow.files.map((f) => f.display_path), ['a.md']);
  const deepProbe = await collect(session, { base_dir: root, files: ['x/*/*/deep.md'] }, config);
  assert.equal(deepProbe.files.length, 1);

  const { walk, MAX_VISITED_ENTRIES } = await import('../src/stages/files.js');
  assert.equal(MAX_VISITED_ENTRIES, 20000);
  const many = path.join(root, 'many');
  await fs.mkdir(many);
  await Promise.all(Array.from({ length: 20001 }, (_, i) => fs.writeFile(path.join(many, `f${i}`), '')));
  await assert.rejects(walk(many), (e) => e.type === 'invalid_input' && /narrow/.test(e.message));
});

test('glob matcher supports **, *, ?, [..] and {a,b}', () => {
  const m = (glob, file) => globToRegExp(glob, '/r/').test(`/r/${file}`);
  assert.ok(m('**/*.js', 'a.js') && m('**/*.js', 'a/b/c.js') && !m('**/*.js', 'a.ts'));
  assert.ok(m('src/*.js', 'src/a.js') && !m('src/*.js', 'src/x/a.js'));
  assert.ok(m('a?.js', 'ab.js') && !m('a?.js', 'a.js'));
  assert.ok(m('[ab].txt', 'a.txt') && !m('[ab].txt', 'c.txt') && m('[!ab].txt', 'c.txt'));
  assert.ok(m('*.{js,ts}', 'x.ts') && !m('*.{js,ts}', 'x.md') && m('{a,b/{c,d}}/x', 'b/d/x'));
  assert.ok(m('src/**', 'src/a/b') && m('a.b', 'a.b') && !m('a.b', 'axb'));
});

test('absolute glob patterns and a base_dir containing glob characters work', async (t) => {
  const dir = await tempDir(t);
  await writeTree(dir, { '[weird]/src/a.js': 'a', '[weird]/src/b.txt': 'b' });
  const config = testConfig(dir);
  const session = await createSession(config);
  const base = path.join(dir, '[weird]');
  const rel = await collect(session, { base_dir: base, files: ['src/*.js'] }, config);
  assert.deepEqual(rel.files.map((f) => f.display_path), ['src/a.js']);
  const abs = await collect(session, { base_dir: base, files: [path.join(base, 'src', '*.js').replace('[weird]', '[[]weird]')] }, config);
  assert.deepEqual(abs.files.map((f) => f.display_path), ['src/a.js']);
});

// 4
test('unknown top-level input keys are rejected by name', async (t) => {
  const { root, config, session } = await project(t, { 'a.txt': 'a' });
  await assert.rejects(collect(session, { file: ['a.txt'], context: 'x' }, config), (e) => e.type === 'invalid_input' && e.message.includes('"file"'));
});

// 5
test('tool input schema avoids oneOf and union types and gives every array items', () => {
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    assert.ok(!('oneOf' in node));
    assert.ok(!Array.isArray(node.type));
    if (node.type === 'array') assert.ok(node.items, 'array without items');
    Object.values(node).forEach(walk);
  };
  walk(tool.inputSchema);
  assert.deepEqual(tool.inputSchema.properties.questions.additionalProperties.properties.instructions, { type: 'string' });
  assert.match(tool.description, /at least one of "files" or "context"/);
  assert.ok(tool.description.length < 3500);
  assert.ok(!tool.description.includes('add -N'));
});

// 6, 7: CLI
test('switching provider drops the key, model and base_url unless given again', async (t) => {
  const dir = await tempDir(t);
  const env = isolatedEnv(dir);
  await fs.writeFile(env.JEV_ANSWERS_CONFIG, JSON.stringify({ api_key: 'ts-key-1234567890', model: 'jev-1.13.0', base_url: 'https://gw.example/v1' }));
  const noKey = await runCli(['setup', '--yes', '--provider', 'openrouter'], { env });
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /--api-key/);
  const ok = await runCli(['setup', '--yes', '--provider', 'openrouter', '--api-key', 'or-key-1234567890'], { env });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(env.JEV_ANSWERS_CONFIG, 'utf8')), { provider: 'openrouter', api_key: 'or-key-1234567890' });

  // interactive: a provider change with Enter at the key prompt stores no old key
  await fs.writeFile(env.JEV_ANSWERS_CONFIG, JSON.stringify({ api_key: 'ts-key-1234567890', model: 'jev-1.13.0' }));
  const wizard = await runCli(['setup'], { env, input: 'openrouter\n\n\n\n' });
  assert.equal(wizard.code, 0, wizard.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(env.JEV_ANSWERS_CONFIG, 'utf8')), { provider: 'openrouter' });
});

test('prompts treat end of input as "no" instead of hanging', async (t) => {
  const dir = await tempDir(t);
  const env = isolatedEnv(dir);
  const config = testConfig(dir);
  const session = await createSession(config);
  await writeJson(session, 'meta.json', { ...(await readJson(session, 'meta.json')), created_at: '2020-01-01T00:00:00+00:00' });
  const result = await runCli(['prune', '--older-than', '30d'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Nothing deleted/);
  assert.equal((await readJson(session, 'meta.json')).id, session.id);
});

test('one prompter serves the whole wizard, including the registration questions', async (t) => {
  const dir = await tempDir(t);
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  await writeTree(bin, { codex: `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n` });
  await fs.chmod(path.join(bin, 'codex'), 0o755);
  const env = isolatedEnv(dir, { PATH: bin }); // only the fake client is installed
  const result = await runCli(['setup'], { env, input: 'typesafe\nkey-1234567890abcdef\n\n\ny\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(log, 'utf8'), /^mcp add jev-answers -- /);
});

// 8
test('numeric config values are range checked', () => {
  const file = '/nonexistent/x.json';
  for (const [name, value] of [['TIMEOUT_MS', '999'], ['TIMEOUT_MS', '2147483648'], ['MAX_RETRIES', '11'], ['MAX_RETRIES', '-1'], ['MAX_FILES', '0']]) {
    assert.throws(() => loadConfig({ env: { [`JEV_ANSWERS_${name}`]: value }, file }), new RegExp(`JEV_ANSWERS_${name}`));
  }
  assert.equal(loadConfig({ env: { JEV_ANSWERS_TIMEOUT_MS: '1000', JEV_ANSWERS_MAX_RETRIES: '10' }, file }).values.max_retries, 10);
});

// 9
test('large provider error bodies are truncated', async (t) => {
  const big = 'x'.repeat(20000);
  const { config, session } = await sendEnv(t, (req, res) => reply(res, 400, { error: { message: 'bad' }, filler: big }));
  await assert.rejects(send(session, config, fast), (e) => {
    assert.equal(e.details.body_truncated, true);
    assert.equal(typeof e.details.body, 'string');
    assert.ok(e.details.body.length <= 8192);
    return true;
  });
  assert.deepEqual(limitBody({ a: 1 }), { body: { a: 1 } });
});

// 10
test('meta.http describes the last attempt only', async (t) => {
  const { config, session } = await sendEnv(t, (req, res, body, n) => (n === 1 ? reply(res, 503, {}) : req.socket.destroy()));
  await assert.rejects(send(session, config, fast), (e) => e.type === 'network_error');
  const { http } = await readJson(session, 'meta.json');
  assert.deepEqual(http, { attempts: 2 });
});

test('redirects and invalid URLs are not retried', async (t) => {
  const { fake, config, session } = await sendEnv(t, (req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/x' }); res.end(); }, { max_retries: 3 });
  await assert.rejects(send(session, config, fast), (e) => e.type === 'provider_error' && /base_url/.test(e.message));
  assert.equal(fake.requests.length, 1);
  await assert.rejects(send(session, { ...config, base_url: 'not a url' }, fast), (e) => e.type === 'config_error');
});

test('a long Retry-After stops retrying', async (t) => {
  const { fake, config, session } = await sendEnv(t, (req, res) => reply(res, 429, {}, { 'retry-after': '120' }), { max_retries: 5 });
  await assert.rejects(send(session, config, fast), (e) => e.type === 'rate_limited' && e.details.retry_after_seconds === 120);
  assert.equal(fake.requests.length, 1);
  const overloaded = await sendEnv(t, (req, res) => reply(res, 529, {}, { 'retry-after': '300' }));
  await assert.rejects(send(overloaded.session, overloaded.config, fast), (e) => e.type === 'overloaded' && e.details.retry_after_seconds === 300);
});

test('non-https base_url is refused unless loopback', async (t) => {
  const { config, session } = await sendEnv(t);
  await assert.rejects(send(session, { ...config, base_url: 'http://api.example.com/v1' }, fast), (e) => e.type === 'config_error' && /cleartext/.test(e.message));
  for (const ok of ['http://localhost:1/x', 'http://127.0.0.1/x', 'http://[::1]:8080/x', 'https://api.example.com/x']) checkBaseUrl(ok);
  assert.throws(() => checkBaseUrl('http://127.0.0.1.evil.com/x'));
});

test('base_url userinfo and query are redacted in meta.json and config output', async (t) => {
  assert.equal(redactUrl('https://user:pw@host.example/v1?key=SECRET'), 'https://host.example/v1');
  assert.equal(redact({ base_url: 'https://u:p@h.example/x?token=1' }).base_url, 'https://h.example/x');
  const dir = await tempDir(t);
  const config = testConfig(dir, { base_url: 'https://u:p@h.example/x?token=1' });
  const session = await createSession(config);
  const raw = await fs.readFile(path.join(session.dir, 'meta.json'), 'utf8');
  assert.ok(!raw.includes('token') && !raw.includes('u:p'));
});

// 11
test('token estimate counts non-ASCII text at about one token per character', () => {
  assert.equal(estimateTokens('a'.repeat(35)), 10);
  assert.equal(estimateTokens('س'.repeat(100)), 100);
  assert.equal(estimateTokens('漢'.repeat(10) + 'a'.repeat(7)), 12);
  assert.equal(estimateTokens(''), 0);
});

// 12
test('session files are private', async (t) => {
  const { dir, root, config, session } = await project(t, { 'a.txt': 'a' });
  await collect(session, { base_dir: root, files: ['a.txt'] }, config);
  const fake = await fakeProvider(t);
  const result = await ask({ base_dir: root, files: ['a.txt'], questions: QUESTIONS }, { config: { ...config, base_url: fake.url } });
  for (const name of ['input.json', 'manifest.json', 'request.json', 'response.json', 'meta.json', 'inputs/a.txt']) {
    assert.equal((await fs.stat(path.join(result.session, name))).mode & 0o777, 0o600, name);
  }
  assert.equal((await fs.stat(result.session)).mode & 0o777, 0o700);
  assert.ok(dir);
});

// 13, 14
test('maskKey only shows edges of long keys', () => {
  assert.equal(maskKey('abcdefghijklmno'), '****');
  assert.equal(maskKey('abcdefghijklmnop'), 'abcd…mnop');
  assert.equal(maskKey(undefined), '(not set)');
});

test('extended secret file patterns', () => {
  for (const yes of ['.envrc', 'prod.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup', '/h/.docker/config.json', 'key.ppk', '.htpasswd',
    'id_rsa_work', 'id_ed25519-old', 'id_ecdsa.bak', '.env.production']) {
    assert.equal(isSecretFile(yes), true, yes);
  }
  for (const no of ['.env.local.example', '.env.prod.sample', '.env.x.template', '.env.y.dist', 'id_rsa_work.pub', 'config.json', 'terraform.tf']) {
    assert.equal(isSecretFile(no), false, no);
  }
});
