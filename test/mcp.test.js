import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { createHandler } from '../src/mcp/server.js';
import { tool } from '../src/mcp/tool.js';
import { BIN, fakeProvider, isolatedEnv, OK_RESPONSE, QUESTIONS, reply, tempDir, writeTree } from './helpers.js';

/** Spawn `serve` and give back a tiny JSON-RPC client. */
async function startServer(t, handler, extraEnv = {}) {
  const dir = await tempDir(t);
  const fake = await fakeProvider(t, handler);
  const env = isolatedEnv(dir, { JEV_ANSWERS_BASE_URL: fake.url, JEV_ANSWERS_API_KEY: 'k-1234567890', JEV_ANSWERS_MAX_RETRIES: '0', ...extraEnv });
  const child = spawn(process.execPath, [BIN, 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const stdoutLines = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    stdoutLines.push(line);
    waiters.splice(0).forEach((w) => w());
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));

  const nextMessage = async (predicate = () => true, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = stdoutLines.findIndex((l) => predicate(JSON.parse(l)));
      if (index >= 0) return JSON.parse(stdoutLines.splice(index, 1)[0]);
      if (Date.now() > deadline) throw new Error(`timed out; stdout so far: ${stdoutLines}`);
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  const send = (msg) => child.stdin.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n');
  const request = async (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, params });
    return nextMessage((m) => m.id === id);
  };
  return { dir, fake, child, send, request, nextMessage, stdoutLines, stderr: () => stderr };
}

test('initialize, tools/list, ping, unknown method, parse error', async (t) => {
  const s = await startServer(t);
  const init = await s.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'jev-answers');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.ok(init.result.instructions.includes('jev_ask'));

  const old = await s.request(2, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(old.result.protocolVersion, '2025-11-25');

  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual((await s.request(3, 'ping')).result, {});

  const list = await s.request(4, 'tools/list');
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, 'jev_ask');
  assert.deepEqual(list.result.tools[0].annotations, tool.annotations);

  assert.equal((await s.request(5, 'nope/nothing')).error.code, -32601);

  s.send('{ this is not json');
  const parseError = await s.nextMessage((m) => m.error?.code === -32700);
  assert.equal(parseError.id, null);

  s.send({ id: 6, method: 'ping' });
  assert.equal((await s.nextMessage((m) => m.id === 6)).error.code, -32600);

  s.send([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', id: 8, method: 'ping' }]);
  const batch = await s.nextMessage(Array.isArray.bind(Array));
  assert.deepEqual(batch.map((m) => m.id), [7, 8]);
});

test('tools/call: ok result, progress, and stdout stays pure JSON-RPC', async (t) => {
  const s = await startServer(t);
  await writeTree(s.dir, { 'p/a.js': 'const a = 1;\n' });
  const res = await s.request(10, 'tools/call', {
    name: 'jev_ask',
    arguments: { base_dir: path.join(s.dir, 'p'), files: ['a.js'], questions: QUESTIONS, label: 'e2e' },
    _meta: { progressToken: 'tok' },
  });
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.structuredContent.status, 'ok');
  assert.deepEqual(res.result.structuredContent.response, OK_RESPONSE);
  assert.deepEqual(JSON.parse(res.result.content[0].text), res.result.structuredContent);
  assert.match(res.result.structuredContent.session, /e2e-[0-9a-f]{4}$/);
  assert.equal(s.fake.requests[0].headers.authorization, 'Bearer k-1234567890');
  await fs.access(path.join(res.result.structuredContent.session, 'response.json'));

  const progress = [];
  while (progress.length < 3) progress.push(await s.nextMessage((m) => m.method === 'notifications/progress'));
  assert.deepEqual(progress.map((m) => [m.params.progressToken, m.params.progress, m.params.total, m.params.message]),
    [['tok', 1, 3, 'collect'], ['tok', 2, 3, 'build'], ['tok', 3, 3, 'send']]);
  assert.equal(s.stdoutLines.length, 0, 'unexpected extra stdout lines');
});

test('tools/call: pipeline errors are tool results with isError, protocol errors are JSON-RPC errors', async (t) => {
  const s = await startServer(t, (req, res) => reply(res, 401, { detail: 'bad' }));
  const failed = await s.request(1, 'tools/call', { name: 'jev_ask', arguments: { context: 'x', questions: QUESTIONS } });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.status, 'error');
  assert.equal(failed.result.structuredContent.error.type, 'auth_error');
  assert.equal(failed.result.structuredContent.error.stage, 'send');

  const invalid = await s.request(2, 'tools/call', { name: 'jev_ask', arguments: { context: 'x' } });
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent.error.type, 'invalid_question');

  assert.equal((await s.request(3, 'tools/call', { name: 'other_tool', arguments: {} })).error.code, -32602);
  assert.equal((await s.request(4, 'tools/call', { name: 'jev_ask', arguments: [] })).error.code, -32602);
});

test('notifications/cancelled aborts the in-flight call without a response', async (t) => {
  const s = await startServer(t, () => { /* never answer */ });
  s.send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'jev_ask', arguments: { context: 'x', questions: QUESTIONS } } });
  while (s.fake.requests.length === 0) await new Promise((r) => setTimeout(r, 20));
  s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 20 } });
  assert.equal((await s.request(21, 'ping')).id, 21);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.stdoutLines.filter((l) => JSON.parse(l).id === 20).length, 0);
});

test('server exits cleanly when stdin ends', async (t) => {
  const s = await startServer(t);
  await s.request(1, 'ping');
  const closed = new Promise((resolve) => s.child.on('close', (code) => resolve(code)));
  s.child.stdin.end();
  assert.equal(await closed, 0);
});

test('a message sent right before stdin closes still gets its reply', async (t) => {
  const dir = await tempDir(t);
  const child = spawn(process.execPath, [BIN], { env: isolatedEnv(dir), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  await new Promise((resolve) => child.on('close', resolve));
  assert.deepEqual(JSON.parse(out), { jsonrpc: '2.0', id: 1, result: {} });
});

test('handler: config errors come back as a tool error without a session', async () => {
  const { handle } = createHandler({ send() {} , ask: async () => ({ session: null, status: 'error', error: { stage: 'config', type: 'config_error', message: 'x' } }) });
  const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jev_ask', arguments: {} } });
  assert.equal(reply.result.isError, true);
});

test('tool description covers the essentials and stays a reasonable size', () => {
  const d = tool.description;
  assert.ok(d.length > 2000 && d.length < 4500, `length ${d.length}`);
  for (const needle of ['probability', 'git diff', '--no-index', 'context_too_large', 'session', 'noul', 'choice', 'score']) {
    assert.ok(d.includes(needle), needle);
  }
  assert.deepEqual(tool.inputSchema.required, ['questions']);
});
