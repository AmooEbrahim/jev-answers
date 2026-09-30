import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { BIN, isolatedEnv, tempDir } from './helpers.js';

// Piped stdin takes a different prompter path, so the real-terminal path needs a pseudo-terminal.
// util-linux `script` provides one; skip where it isn't available.
const hasScript = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

/** Run a command in a pty, answering each prompt (regex) as soon as it appears. */
function runInPty(command, env, answers, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-qec', command, '/dev/null'], { env });
    let output = '';
    const pending = [...answers];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pty run timed out; output so far:\n${output}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      while (pending.length && pending[0][0].test(output)) {
        const [pattern, answer] = pending.shift();
        output = output.replace(pattern, '');
        child.stdin.write(answer + '\r');
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, unanswered: pending.length });
    });
  });
}

test('interactive setup works on a real terminal and hides the key', { skip: !hasScript && 'needs util-linux script' }, async (t) => {
  const dir = await tempDir(t);
  // No MCP clients on PATH, so the wizard asks no registration questions.
  const env = { ...isolatedEnv(dir), PATH: '/usr/bin:/bin', SHELL: '/bin/sh' };
  const key = 'tty-secret-key-0123456789';
  const result = await runInPty(`'${process.execPath}' '${BIN}' setup`, env, [
    [/Provider \[typesafe\]: /, 'openrouter'],
    [/API key.*: /, key],
    [/Model \[.*\]: /, ''],
    [/Session folder \[.*\]: /, ''],
  ]);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.unanswered, 0);
  assert.ok(!result.output.includes(key), 'the key must not be echoed');
  const configPath = path.join(dir, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(config.provider, 'openrouter');
  assert.equal(config.api_key, key);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});
