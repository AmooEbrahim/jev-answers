import fs from 'node:fs/promises';
import { ErrorType, JevAnswersError } from '../errors.js';
import { getProvider } from '../providers/index.js';
import { validateQuestions } from '../questions.js';
import { readJson, sessionFile, updateMeta, writeJson } from '../session.js';
import { estimateJsonTokens, estimateTokens } from '../tokens.js';

async function buildState(session, input, manifest) {
  const state = {};
  if (input.context?.trim()) state.context = input.context;
  state.files = [];
  for (const file of manifest.files) {
    // Read the session's copy, so what is recorded is exactly what gets sent.
    const content = await fs.readFile(sessionFile(session, file.copy), 'utf8');
    const entry = { path: file.display_path };
    if (file.label) entry.label = file.label;
    entry.content = content;
    state.files.push(entry);
  }
  if (!state.files.length) delete state.files;
  return state;
}

function estimate(state, questions, config) {
  const stateTokens = estimateJsonTokens(state);
  const questionTokens = Object.values(questions).map(estimateJsonTokens);
  const longest = Math.max(...questionTokens);
  return {
    state_tokens: stateTokens,
    longest_question_tokens: longest,
    total_tokens: stateTokens + questionTokens.reduce((a, b) => a + b, 0),
    max_input_tokens: config.max_input_tokens,
    max_total_tokens: config.max_total_tokens,
  };
}

function enforceLimits(est, state) {
  const inputTokens = est.state_tokens + est.longest_question_tokens;
  if (inputTokens <= est.max_input_tokens && est.total_tokens <= est.max_total_tokens) return;
  const largestFiles = (state.files ?? [])
    .map((f) => ({ path: f.path, tokens: estimateTokens(f.content), bytes: Buffer.byteLength(f.content) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
  const which =
    inputTokens > est.max_input_tokens
      ? `state + longest question is ~${inputTokens} tokens (limit ${est.max_input_tokens})`
      : `state + all questions is ~${est.total_tokens} tokens (limit ${est.max_total_tokens})`;
  throw new JevAnswersError(
    ErrorType.CONTEXT_TOO_LARGE,
    `Input is too large: ${which}. Drop or shrink files; the largest are listed in details.largest_files.`,
    { ...est, input_tokens: inputTokens, largest_files: largestFiles },
  );
}

/**
 * Stage 2: read input.json, manifest.json and the collected copies; write request.json.
 * @param {{model?: string}} [overrides]
 */
export async function build(session, config, overrides = {}) {
  const input = await readJson(session, 'input.json');
  const manifest = await readJson(session, 'manifest.json');
  const provider = getProvider(config.provider);

  const model = overrides.model ?? config.model;
  if (typeof model !== 'string' || !model.trim()) {
    throw new JevAnswersError(ErrorType.INVALID_INPUT, '"model" must be a non-empty string.');
  }
  const questions = validateQuestions(input.questions);
  const state = await buildState(session, input, manifest);

  const est = estimate(state, questions, config);
  await updateMeta(session, { model, estimate: est });
  enforceLimits(est, state);

  const body = provider.buildBody({ model, state, questions });
  await writeJson(session, 'request.json', body);
  return body;
}
