import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fakeProvider, isolatedEnv, OK_RESPONSE, QUESTIONS, runCli, tempDir, writeTree } from './helpers.js';

async function cliEnv(t, handler) {
  const dir = await tempDir(t);
  const fake = await fakeProvider(t, handler);
  const env = isolatedEnv(dir, { JEV_ANSWERS_BASE_URL: fake.url, JEV_ANSWERS_API_KEY: 'abcd1234567890wxyz', JEV_ANSWERS_MAX_RETRIES: '0' });
  return { dir, fake, env, cli: (args, opts) => runCli(args, { env, ...opts }) };
}

const ask = (cli, input) => cli(['ask', '-'], { input: JSON.stringify(input) });

test('--help, --version and unknown commands', async (t) => {
  const { cli } = await cliEnv(t);
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /jev-answers serve/);
  assert.match((await cli(['--version'])).stdout, /^\d+\.\d+\.\d+/);
  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);
  assert.equal(unknown.stdout, '');
});

test('config masks the key and doctor reports sources', async (t) => {
  const { cli } = await cliEnv(t);
  const config = await cli(['config']);
  assert.match(config.stdout, /abcd…wxyz/);
  assert.ok(!config.stdout.includes('abcd1234567890wxyz'));
  const doctor = await cli(['doctor']);
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /api_key\s+abcd…wxyz\s+\(env\)/);
  assert.match(doctor.stdout, /session folder .* is writable/);
});

test('doctor --live sends one small question', async (t) => {
  const { cli, fake } = await cliEnv(t);
  const live = await cli(['doctor', '--live']);
  assert.equal(live.code, 0, live.stdout);
  assert.match(live.stdout, /live request succeeded/);
  assert.equal(fake.requests.length, 1);
});

test('ask from stdin and from a file, exit codes', async (t) => {
  const { dir, cli } = await cliEnv(t);
  const ok = await ask(cli, { context: 'x', questions: QUESTIONS });
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.stdout).response, OK_RESPONSE);

  const file = path.join(dir, 'input.json');
  await fs.writeFile(file, JSON.stringify({ context: 'x', questions: QUESTIONS }));
  assert.equal((await cli(['ask', file])).code, 0);

  const bad = await ask(cli, { context: 'x' });
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).error.type, 'invalid_question');

  assert.equal((await cli(['ask', '-'], { input: 'not json' })).code, 2);
  assert.equal((await cli(['ask', path.join(dir, 'missing.json')])).code, 2);
});

test('list, show, resend and prune work on real sessions', async (t) => {
  const { cli, fake } = await cliEnv(t);
  assert.match((await cli(['list'])).stdout, /No sessions/);
  const first = JSON.parse((await ask(cli, { context: 'x', questions: QUESTIONS, label: 'first' })).stdout);
  const second = JSON.parse((await ask(cli, { context: 'y', questions: QUESTIONS, label: 'second' })).stdout);

  const list = await cli(['list']);
  const rows = list.stdout.trim().split('\n');
  assert.equal(rows.length, 2);
  assert.match(rows[0], /second/);
  assert.match(rows[0], /ok\s+typesafe\/jev-latest/);
  assert.equal((await cli(['list', '--limit', '1'])).stdout.trim().split('\n').length, 1);
  assert.equal((await cli(['list', '--limit', '0'])).code, 2);

  const show = await cli(['show', path.basename(first.session)]);
  assert.deepEqual(JSON.parse(show.stdout), OK_RESPONSE);
  assert.equal((await cli(['show', 'latest', '--path'])).stdout.trim(), second.session);
  assert.equal((await cli(['show', 'no-such-session'])).code, 1);

  const resent = await cli(['resend', 'latest']);
  assert.equal(resent.code, 0);
  const resentResult = JSON.parse(resent.stdout);
  assert.notEqual(resentResult.session, second.session);
  assert.equal(fake.requests.length, 3);
  assert.deepEqual(fake.requests[2].body, fake.requests[1].body);

  assert.equal((await cli(['prune'])).code, 2);
  const nothing = await cli(['prune', '--older-than', '30d', '--yes']);
  assert.match(nothing.stdout, /No sessions older/);
  assert.equal((await cli(['list'])).stdout.trim().split('\n').length, 3);
  // Age every session artificially, then prune.
  for (const dir of [first.session, second.session, resentResult.session]) {
    const metaFile = path.join(dir, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    await fs.writeFile(metaFile, JSON.stringify({ ...meta, created_at: '2020-01-01T00:00:00+00:00' }));
  }
  const declined = await cli(['prune', '--older-than', '30d'], { input: 'n\n' });
  assert.match(declined.stdout, /Nothing deleted/);
  const pruned = await cli(['prune', '--older-than', '30d', '--yes']);
  assert.match(pruned.stdout, /Deleted 3/);
  assert.match((await cli(['list'])).stdout, /No sessions/);
});

test('setup --yes writes a private config file and merges with an existing one', async (t) => {
  const dir = await tempDir(t);
  const env = isolatedEnv(dir);
  await writeTree(dir, { 'config.json': JSON.stringify({ timeout_ms: 9999, api_key: 'old-key-1234567' }) });
  const result = await runCli(['setup', '--yes', '--provider', 'openrouter', '--api-key', 'sk-or-abcdefghij1234', '--model', 'custom-model'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('sk-or-abcdefghij1234'));
  assert.match(result.stdout, /mcpServers/);
  assert.match(result.stdout, /mcp_servers\.jev-answers/);
  assert.match(result.stdout, /"type": "local"/);
  const file = env.JEV_ANSWERS_CONFIG;
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
    timeout_ms: 9999, api_key: 'sk-or-abcdefghij1234', provider: 'openrouter', model: 'custom-model',
  });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  // Same provider again: the stored key and model are kept.
  assert.equal((await runCli(['setup', '--yes', '--provider', 'openrouter'], { env })).code, 0);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).api_key, 'sk-or-abcdefghij1234');
  assert.equal((await runCli(['setup', '--yes', '--provider', 'nope'], { env })).code, 2);
  assert.equal((await runCli(['setup', '--yes', '--register', 'vim'], { env })).code, 2);
});

test('setup creates the config directory privately', async (t) => {
  const dir = await tempDir(t);
  const env = isolatedEnv(dir, { JEV_ANSWERS_CONFIG: path.join(dir, 'nested', 'jev', 'config.json') });
  assert.equal((await runCli(['setup', '--yes', '--api-key', 'abc'], { env })).code, 0);
  assert.equal((await fs.stat(path.join(dir, 'nested', 'jev'))).mode & 0o777, 0o700);
});

test('invalid config file is reported cleanly', async (t) => {
  const dir = await tempDir(t);
  const env = isolatedEnv(dir);
  await fs.writeFile(env.JEV_ANSWERS_CONFIG, '{oops');
  const result = await runCli(['config'], { env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not valid JSON/);
});

test('interactive setup reads piped answers and keeps the key out of the output', async (t) => {
  const dir = await tempDir(t);
  const env = isolatedEnv(dir);
  const result = await runCli(['setup'], { env, input: 'openrouter\nsk-or-secretsecret1234\n\n/custom/home\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('sk-or-secretsecret1234'));
  assert.deepEqual(JSON.parse(await fs.readFile(env.JEV_ANSWERS_CONFIG, 'utf8')), {
    provider: 'openrouter', api_key: 'sk-or-secretsecret1234', home: '/custom/home',
  });
});

test('setup --register runs the client command without a shell', async (t) => {
  const dir = await tempDir(t);
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  await writeTree(bin, { claude: `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n` });
  await fs.chmod(path.join(bin, 'claude'), 0o755);
  const env = isolatedEnv(dir, { PATH: `${bin}:${process.env.PATH}` });
  const result = await runCli(['setup', '--yes', '--api-key', 'abc', '--register', 'claude'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`$ claude mcp add --scope user jev-answers -- ${process.execPath} `));
  assert.match(await fs.readFile(log, 'utf8'), /^mcp add --scope user jev-answers -- \/.*node.* .*bin\/jev-answers\.js serve$/m);
});
