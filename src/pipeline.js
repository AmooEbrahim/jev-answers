import fs from 'node:fs/promises';
import { loadConfig } from './config.js';
import { STAGES } from './constants.js';
import { ErrorType, JevAnswersError, redactSecrets, toErrorRecord } from './errors.js';
import { build } from './stages/build.js';
import { collect } from './stages/collect.js';
import { send } from './stages/send.js';
import { createSession, readJson, sessionFile, updateMeta, writeJson } from './session.js';

/**
 * @typedef {object} RunOptions
 * @property {object} [config]        effective config values (defaults to loadConfig())
 * @property {AbortSignal} [signal]
 * @property {(stage: string, step: number, total: number) => void} [onProgress]
 * @property {number} [backoffBaseMs] test hook: base delay between retries
 */

// Every recorded or returned error passes through here, so the API key cannot leak.
const failure = (session, err, stage, config) => ({
  session: session?.dir ?? null,
  status: 'error',
  error: redactSecrets(toErrorRecord(err, stage), config?.api_key),
});

/** Run stages in order, timing each; on error record error.json and meta, never throw. */
async function runStages(session, steps, opts, config) {
  const debug = (line) => config.debug && process.stderr.write(`jev-answers: ${line}\n`);
  let stage = 'session';
  try {
    for (const [index, [name, run]] of steps.entries()) {
      stage = name;
      const started = Date.now();
      try {
        await run();
      } finally {
        await updateMeta(session, { stages: { [name]: { ms: Date.now() - started } } });
      }
      debug(`${session.id}: ${name} done`);
      opts.onProgress?.(name, index + 1, steps.length);
    }
    await updateMeta(session, { status: 'ok' });
    return { session: session.dir, status: 'ok', response: await readJson(session, 'response.json') };
  } catch (err) {
    const result = failure(session, err, stage, config);
    debug(`${session.id}: ${stage} failed: ${result.error.type}`);
    await writeJson(session, 'error.json', result.error).catch(() => {});
    await updateMeta(session, { status: 'error' }).catch(() => {});
    return result;
  }
}

function loadOrFail(opts) {
  try {
    return { config: opts.config ?? loadConfig().values };
  } catch (err) {
    return { result: failure(null, err, 'config') };
  }
}

/**
 * Create a session and run collect -> build -> send. Never throws.
 * @param {object} input the jev_ask arguments
 * @param {RunOptions} [opts]
 */
export async function ask(input, opts = {}) {
  const { config, result } = loadOrFail(opts);
  if (result) return result;

  let session;
  try {
    const label = typeof input?.label === 'string' ? input.label : undefined;
    session = await createSession(config, { label });
    await writeJson(session, 'input.json', input ?? null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new JevAnswersError(ErrorType.INVALID_INPUT, 'The tool input must be a JSON object.');
    }
  } catch (err) {
    const result = failure(session, err, session ? 'collect' : 'session', config);
    if (session) {
      await writeJson(session, 'error.json', result.error).catch(() => {});
      await updateMeta(session, { status: 'error' }).catch(() => {});
    }
    return result;
  }

  const [collectName, buildName, sendName] = STAGES;
  return runStages(
    session,
    [
      [collectName, () => collect(session, input, config)],
      [buildName, () => build(session, config, { model: input.model })],
      [sendName, () => send(session, config, opts)],
    ],
    opts,
    config,
  );
}

/** Copy an earlier session's request into a new session and run only the send stage. */
export async function resend(oldSession, opts = {}) {
  const { config, result } = loadOrFail(opts);
  if (result) return result;

  let session;
  try {
    const old = await readJson(oldSession, 'meta.json').catch(() => ({}));
    if (!(await fs.stat(sessionFile(oldSession, 'request.json')).catch(() => null))) {
      throw new JevAnswersError(ErrorType.MISSING_ARTIFACT, `Session ${oldSession.id} has no request.json to resend.`);
    }
    session = await createSession(config, { label: old.label ?? undefined });
    for (const name of ['input.json', 'manifest.json', 'request.json']) {
      await fs.copyFile(sessionFile(oldSession, name), sessionFile(session, name)).catch(() => {});
    }
    await fs.cp(sessionFile(oldSession, 'inputs'), sessionFile(session, 'inputs'), { recursive: true }).catch(() => {});
    await updateMeta(session, { resent_from: oldSession.id, model: old.model ?? config.model, estimate: old.estimate });
  } catch (err) {
    return failure(session, err, 'session', config);
  }
  return runStages(session, [[STAGES[2], () => send(session, config, opts)]], opts, config);
}
