import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configPath, loadConfig, maskKey } from '../config.js';
import { DEFAULTS, NAME } from '../constants.js';
import { ErrorType, JevAnswersError } from '../errors.js';
import { getProvider, PROVIDER_NAMES } from '../providers/index.js';
import { parse } from './args.js';
import { CLIENTS, launchCommand, onPath, snippets } from './launch.js';
import { createPrompter } from './prompt.js';
import { err, out } from './output.js';

const KEY_URLS = { typesafe: 'https://console.typesafe.ai', openrouter: 'https://openrouter.ai/keys' };
const PROVIDER_BLURB = {
  typesafe: 'typesafe   - TypeSafe direct API (cheapest; key from console.typesafe.ai)',
  openrouter: 'openrouter - via OpenRouter (one bill for many models; key from openrouter.ai/keys)',
};

async function readExisting(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new JevAnswersError(ErrorType.CONFIG, `Cannot update ${file}: ${e.message}. Fix or remove it and run setup again.`);
  }
}

async function writeConfig(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600); // writeFile's mode only applies to new files
}

async function interactiveAnswers(prompt, existing) {
  out(`${NAME} setup\n`);
  out('Providers:');
  for (const name of PROVIDER_NAMES) out(`  ${PROVIDER_BLURB[name]}`);
  const currentProvider = existing.provider ?? DEFAULTS.provider;
  let provider = (await prompt.ask(`Provider [${currentProvider}]: `)) || currentProvider;
  while (!PROVIDER_NAMES.includes(provider)) {
    provider = (await prompt.ask(`Choose one of ${PROVIDER_NAMES.join(', ')} [${currentProvider}]: `)) || currentProvider;
  }
  const sameProvider = provider === currentProvider;

  out(`\nGet an API key at ${KEY_URLS[provider]}`);
  const keptKey = sameProvider ? existing.api_key : undefined;
  const keyHint = keptKey ? ` [${maskKey(keptKey)}, Enter keeps it]` : '';
  const apiKey = (await prompt.ask(`API key${keyHint} (input hidden): `, { secret: true })) || keptKey;

  const defaultModel = (sameProvider && existing.model) || getProvider(provider).defaultModel;
  const model = (await prompt.ask(`Model [${defaultModel}]: `)) || defaultModel;
  const defaultHome = existing.home ?? DEFAULTS.home;
  const home = (await prompt.ask(`Session folder [${defaultHome}]: `)) || defaultHome;
  return { provider, api_key: apiKey, model, home };
}

// Keys, models and URLs belong to one provider: switching providers drops them unless given again.
const PROVIDER_BOUND = ['base_url', 'model', 'api_key'];

function mergeConfig(existing, answers) {
  const changed = answers.provider !== (existing.provider ?? DEFAULTS.provider);
  const merged = { ...existing, provider: answers.provider };
  if (changed) for (const key of PROVIDER_BOUND) delete merged[key];
  if (answers.api_key) merged.api_key = answers.api_key;
  if (answers.base_url) merged.base_url = answers.base_url;
  // Keep the file minimal: values equal to the defaults are not stored.
  const setOrDrop = (key, value, fallback) => {
    if (value && value !== fallback) merged[key] = value;
    else delete merged[key];
  };
  setOrDrop('model', answers.model, getProvider(answers.provider).defaultModel);
  setOrDrop('home', answers.home, DEFAULTS.home);
  return merged;
}

function register(clientName, cmd) {
  const [bin, args] = CLIENTS[clientName](cmd);
  const shown = [bin, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  out(`\n$ ${shown}`);
  if (process.platform === 'win32') {
    // .cmd shims cannot be spawned without a shell, and we never use one.
    out(`Run the command above yourself to register ${clientName}.`);
    return;
  }
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    err(`Registration with ${clientName} failed (${result.error?.message ?? `exit ${result.status}`}). Use the manual snippets below.`);
  }
}

async function offerRegistration(prompt, cmd) {
  for (const name of Object.keys(CLIENTS).filter((client) => onPath(client))) {
    const answer = await prompt.ask(`\nRegister ${NAME} with ${name}? [y/N] `);
    if (/^y(es)?$/i.test(answer)) register(name, cmd);
  }
}

export async function run(argv) {
  const { values } = parse(
    argv,
    {
      provider: { type: 'string' },
      'api-key': { type: 'string' },
      model: { type: 'string' },
      home: { type: 'string' },
      'base-url': { type: 'string' },
      yes: { type: 'boolean', default: false },
      register: { type: 'string' },
    },
    { allowPositionals: false },
  );
  const file = configPath();
  const existing = await readExisting(file);

  let answers;
  let prompt;
  if (values.yes) {
    const provider = values.provider ?? existing.provider ?? DEFAULTS.provider;
    if (!PROVIDER_NAMES.includes(provider)) {
      throw new JevAnswersError(ErrorType.INVALID_INPUT, `--provider must be one of: ${PROVIDER_NAMES.join(', ')}`);
    }
    const changed = provider !== (existing.provider ?? DEFAULTS.provider);
    if (changed && !values['api-key']) {
      throw new JevAnswersError(ErrorType.INVALID_INPUT, `Switching to ${provider} drops the stored key: pass --api-key.`);
    }
    answers = {
      provider,
      api_key: values['api-key'],
      base_url: values['base-url'],
      model: values.model ?? (changed ? undefined : existing.model),
      home: values.home ?? existing.home,
    };
  } else {
    prompt = await createPrompter();
    answers = await interactiveAnswers(prompt, existing).catch((e) => { prompt.close(); throw e; });
  }

  try {
    const merged = mergeConfig(existing, answers);
    await writeConfig(file, merged);
    loadConfig({ file }); // fail loudly if what we wrote does not load
    out(`\nWrote ${file} (key ${maskKey(merged.api_key)})`);
    if (!merged.api_key) out('No API key stored yet: rerun setup or set JEV_ANSWERS_API_KEY.');

    const cmd = launchCommand();
    if (values.yes) {
      for (const name of (values.register ?? '').split(',').filter(Boolean)) {
        if (!CLIENTS[name]) throw new JevAnswersError(ErrorType.INVALID_INPUT, `Unknown client "${name}" in --register.`);
        register(name, cmd);
      }
    } else {
      await offerRegistration(prompt, cmd);
    }
    out(`\nManual configuration for other clients:\n\n${snippets(cmd)}`);
    return 0;
  } finally {
    prompt?.close();
  }
}
