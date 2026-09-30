import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './constants.js';
import { ErrorType, JevAnswersError } from './errors.js';
import { getProvider, PROVIDER_NAMES } from './providers/index.js';

const int = (min, max = Number.MAX_SAFE_INTEGER) => ({ kind: 'int', min, max });
const KEYS = {
  provider: { env: 'JEV_ANSWERS_PROVIDER', kind: 'string' },
  base_url: { env: 'JEV_ANSWERS_BASE_URL', kind: 'string' },
  model: { env: 'JEV_ANSWERS_MODEL', kind: 'string' },
  api_key: { env: 'JEV_ANSWERS_API_KEY', kind: 'string' },
  home: { env: 'JEV_ANSWERS_HOME', kind: 'string' },
  max_input_tokens: { env: 'JEV_ANSWERS_MAX_INPUT_TOKENS', ...int(1) },
  max_total_tokens: { env: 'JEV_ANSWERS_MAX_TOTAL_TOKENS', ...int(1) },
  timeout_ms: { env: 'JEV_ANSWERS_TIMEOUT_MS', ...int(1000, 2147483647) },
  max_retries: { env: 'JEV_ANSWERS_MAX_RETRIES', ...int(0, 10) },
  max_file_bytes: { env: 'JEV_ANSWERS_MAX_FILE_BYTES', ...int(1) },
  max_files: { env: 'JEV_ANSWERS_MAX_FILES', ...int(1) },
  allow_secret_files: { env: 'JEV_ANSWERS_ALLOW_SECRET_FILES', kind: 'bool' },
  retention_days: { env: 'JEV_ANSWERS_RETENTION_DAYS', ...int(0) },
  debug: { env: 'JEV_ANSWERS_DEBUG', kind: 'bool' },
};

export function configPath(env = process.env) {
  if (env.JEV_ANSWERS_CONFIG) return env.JEV_ANSWERS_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'jev-answers', 'config.json');
}

function configError(message) {
  return new JevAnswersError(ErrorType.CONFIG, message);
}

function coerce(spec, raw, where) {
  if (spec.kind === 'string') {
    if (typeof raw !== 'string') throw configError(`${where} must be a string.`);
    return raw;
  }
  if (spec.kind === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    throw configError(`${where} must be true or false (got "${raw}").`);
  }
  const number = typeof raw === 'number' ? raw : /^\s*\d+\s*$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
    const range = spec.max === Number.MAX_SAFE_INTEGER ? `>= ${spec.min}` : `between ${spec.min} and ${spec.max}`;
    throw configError(`${where} must be an integer ${range} (got "${raw}").`);
  }
  return number;
}

function readConfigFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw configError(`Cannot read config file ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw configError(`Config file ${file} is not valid JSON: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw configError(`Config file ${file} must contain a JSON object.`);
  }
  return data;
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Merge defaults < config file < environment.
 * @returns {{values: object, sources: Record<string,string>, file: string}}
 */
export function loadConfig({ env = process.env, file = configPath(env) } = {}) {
  const fileData = readConfigFile(file);
  const values = { ...DEFAULTS };
  const sources = Object.fromEntries(Object.keys(KEYS).map((key) => [key, 'default']));

  for (const [key, spec] of Object.entries(KEYS)) {
    if (fileData[key] !== undefined && fileData[key] !== null) {
      values[key] = coerce(spec, fileData[key], `"${key}" in ${file}`);
      sources[key] = 'file';
    }
    const fromEnv = env[spec.env];
    if (fromEnv !== undefined && fromEnv !== '') {
      values[key] = coerce(spec, fromEnv, `Environment variable ${spec.env}`);
      sources[key] = 'env';
    }
  }

  if (!PROVIDER_NAMES.includes(values.provider)) {
    throw configError(`Unknown provider "${values.provider}". Use one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
  const provider = getProvider(values.provider);
  for (const [key, fallback] of [
    ['base_url', provider.defaultBaseUrl],
    ['model', provider.defaultModel],
  ]) {
    if (sources[key] === 'default') values[key] = fallback;
  }
  if (values.api_key === undefined && env[provider.keyEnv]) {
    values.api_key = env[provider.keyEnv];
    sources.api_key = 'env';
  }
  values.home = path.resolve(expandHome(values.home));
  return { values, sources, file };
}

/** The key must be usable at send time; anything else is a config problem. */
export function requireApiKey(config) {
  const provider = getProvider(config.provider);
  const key = config.api_key?.trim();
  if (!key) {
    throw configError(
      `No API key configured for ${provider.name}. Run "jev-answers setup", or set JEV_ANSWERS_API_KEY or ${provider.keyEnv}.`,
    );
  }
  if (key.includes('${')) {
    throw configError(
      'The API key still contains an unexpanded "${...}" placeholder. Your MCP client did not substitute the environment variable; put the real key in the jev-answers config (run "jev-answers setup") instead.',
    );
  }
  // Also keeps CR/LF and other odd characters out of the Authorization header. The key is not echoed.
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw configError('The API key contains spaces, line breaks or non-ASCII characters. Re-enter it with "jev-answers setup".');
  }
  return key;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** Validate base_url: it must parse, and carry the key over https unless it is loopback. */
export function checkBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw configError(`base_url is not a valid URL: ${redactUrl(baseUrl)}`);
  }
  const loopback = LOOPBACK.test(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url;
  throw configError(
    `base_url must use https (got ${url.protocol}//${url.host}); the API key would travel in cleartext. http is only allowed for localhost.`,
  );
}

/** Drop userinfo and query string, which may carry credentials. */
export function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '(invalid url)';
  }
}

export function maskKey(key) {
  if (!key) return '(not set)';
  if (key.length < 16) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Effective config safe to print. */
export function redact(values) {
  return {
    ...values,
    base_url: values.base_url === undefined ? undefined : redactUrl(values.base_url),
    api_key: values.api_key === undefined ? undefined : maskKey(values.api_key),
  };
}
