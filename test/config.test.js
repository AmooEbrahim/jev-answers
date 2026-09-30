import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, maskKey, redact, requireApiKey } from '../src/config.js';
import { tempDir } from './helpers.js';

test('defaults come from the provider', () => {
  const { values, sources } = loadConfig({ env: { JEV_ANSWERS_CONFIG: '/nonexistent/x.json' }, file: '/nonexistent/x.json' });
  assert.equal(values.provider, 'typesafe');
  assert.equal(values.base_url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(values.model, 'jev-latest');
  assert.equal(values.max_input_tokens, 28000);
  assert.equal(sources.model, 'default');
});

test('openrouter defaults and provider key fallback', () => {
  const { values, sources } = loadConfig({
    env: { JEV_ANSWERS_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: 'ts-key' },
    file: '/nonexistent/x.json',
  });
  assert.equal(values.model, '~typesafe/jev-latest');
  assert.equal(values.base_url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(values.api_key, 'or-key');
  assert.equal(sources.api_key, 'env');
});

test('precedence: default < file < env', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ model: 'from-file', timeout_ms: 1234, max_files: 5, api_key: 'file-key' }));
  const env = { JEV_ANSWERS_MODEL: 'from-env', JEV_ANSWERS_MAX_RETRIES: '7', TYPESAFE_API_KEY: 'env-key' };
  const { values, sources } = loadConfig({ env, file });
  assert.equal(values.model, 'from-env');
  assert.equal(values.timeout_ms, 1234);
  assert.equal(values.max_retries, 7);
  assert.equal(values.max_files, 5);
  assert.equal(values.api_key, 'file-key');
  assert.deepEqual([sources.model, sources.timeout_ms, sources.max_retries, sources.debug], ['env', 'file', 'env', 'default']);
});

test('env values are parsed and bad ones name the variable', () => {
  const file = '/nonexistent/x.json';
  assert.equal(loadConfig({ env: { JEV_ANSWERS_DEBUG: 'true' }, file }).values.debug, true);
  assert.equal(loadConfig({ env: { JEV_ANSWERS_ALLOW_SECRET_FILES: '0' }, file }).values.allow_secret_files, false);
  assert.throws(() => loadConfig({ env: { JEV_ANSWERS_TIMEOUT_MS: 'abc' }, file }), /JEV_ANSWERS_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ env: { JEV_ANSWERS_MAX_FILES: '0' }, file }), /JEV_ANSWERS_MAX_FILES/);
  assert.throws(() => loadConfig({ env: { JEV_ANSWERS_DEBUG: 'maybe' }, file }), /JEV_ANSWERS_DEBUG/);
  assert.throws(() => loadConfig({ env: { JEV_ANSWERS_PROVIDER: 'nope' }, file }), /Unknown provider/);
});

test('invalid JSON in the config file is a config_error', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, '{ not json');
  assert.throws(() => loadConfig({ env: {}, file }), (e) => e.type === 'config_error' && e.message.includes(file));
});

test('config path resolution', () => {
  const { file } = loadConfig({ env: { XDG_CONFIG_HOME: '/xdg' } });
  assert.equal(file, path.join('/xdg', 'jev-answers', 'config.json'));
  assert.equal(loadConfig({ env: { JEV_ANSWERS_CONFIG: '/x/c.json' } }).file, '/x/c.json');
});

test('missing key and unexpanded placeholder are config errors', () => {
  assert.throws(() => requireApiKey({ provider: 'typesafe' }), (e) => e.type === 'config_error' && /setup/.test(e.message));
  assert.throws(() => requireApiKey({ provider: 'typesafe', api_key: '${TYPESAFE_API_KEY}' }), /placeholder/);
  assert.equal(requireApiKey({ provider: 'typesafe', api_key: ' abc ' }), 'abc');
});

test('keys are masked', () => {
  assert.equal(maskKey('abcd1234567890wxyz'), 'abcd…wxyz');
  assert.equal(maskKey('short'), '****');
  assert.equal(redact({ api_key: 'abcd1234567890wxyz' }).api_key, 'abcd…wxyz');
});
