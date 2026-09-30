import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

export const BIN = fileURLToPath(new URL('../bin/jev-answers.js', import.meta.url));

export async function tempDir(t, prefix = 'jev-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write files (relative path -> content) under dir. */
export async function writeTree(dir, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

/** Env for child processes / loadConfig that never touches the real home or config. */
export function isolatedEnv(dir, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    JEV_ANSWERS_HOME: path.join(dir, 'home'),
    JEV_ANSWERS_CONFIG: path.join(dir, 'config.json'),
    ...extra,
  };
}

/** Effective config values for in-process tests. */
export function testConfig(dir, overrides = {}) {
  const { values } = loadConfig({ env: isolatedEnv(dir) });
  return { ...values, api_key: 'test-key-1234567890', ...overrides };
}

export const OK_RESPONSE = {
  model: 'jev-1.13.0',
  answers: { q: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};

/**
 * Local fake provider. `handler(req, res, body, callNo)` decides each reply;
 * the default answers 200 with OK_RESPONSE. All requests are recorded in `.requests`.
 */
export async function fakeProvider(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (handler) return handler(req, res, body, requests.length);
      res.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req-1' });
      res.end(JSON.stringify(OK_RESPONSE));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // `url` is a full endpoint (like base_url); `origin` lets tests pick another path.
  return { url: `${origin}/v1/systemone`, origin, requests };
}

export const reply = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** Run the CLI; resolves {code, stdout, stderr}. */
export function runCli(args, { env, input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

export const QUESTIONS = { q: { type: 'noul', instructions: 'Is it fine?' } };
