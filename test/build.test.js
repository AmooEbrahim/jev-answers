import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validateQuestions } from '../src/questions.js';
import { build } from '../src/stages/build.js';
import { collect } from '../src/stages/collect.js';
import { createSession, readJson, writeJson } from '../src/session.js';
import { QUESTIONS, tempDir, testConfig, writeTree } from './helpers.js';

const bad = (questions) => assert.throws(() => validateQuestions(questions), (e) => e.type === 'invalid_question');

test('question validation accepts each type', () => {
  validateQuestions({
    a: { type: 'noul', instructions: 'x' },
    b: { type: 'noul', instructions: 'x', criteria: { true: 'yes', false: 'no' } },
    c: { type: 'choice', instructions: 'x', criteria: { one: 'first', two: null } },
    d: { type: 'score', instructions: 'x', criteria: ['low', 'high'] },
    e: { type: 'noul', instructions: { q: 'structured?', ctx: [1, 2] } },
  });
});

test('question validation rejects bad shapes', () => {
  bad(undefined);
  bad({});
  bad([]);
  bad({ 'bad id!': { type: 'noul', instructions: 'x' } });
  bad({ a: 'text' });
  bad({ a: { type: 'maybe', instructions: 'x' } });
  bad({ a: { type: 'noul', instructions: '  ' } });
  bad({ a: { type: 'noul' } });
  bad({ a: { type: 'noul', instructions: 'x', extra: 1 } });
  bad({ a: { type: 'noul', instructions: 'x', criteria: { true: 'only' } } });
  bad({ a: { type: 'choice', instructions: 'x' } });
  bad({ a: { type: 'choice', instructions: 'x', criteria: { one: 'only one' } } });
  bad({ a: { type: 'choice', instructions: 'x', criteria: ['a', 'b'] } });
  bad({ a: { type: 'choice', instructions: 'x', criteria: { one: 1, two: 2 } } });
  bad({ a: { type: 'noul', instructions: null } });
  bad({ a: { type: 'score', instructions: 'x', criteria: ['a', null] } });
  bad({ a: { type: 'score', instructions: 'x', criteria: ['one'] } });
  bad({ a: { type: 'score', instructions: 'x', criteria: { a: 'b' } } });
  bad({ a: { type: 'score', instructions: 'x', criteria: ['a', ''] } });
  bad({ ['x'.repeat(65)]: { type: 'noul', instructions: 'x' } });
});

async function collected(t, input, overrides = {}, extraFiles = {}) {
  const dir = await tempDir(t);
  const project = path.join(dir, 'p');
  await writeTree(project, { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2;\n', ...extraFiles });
  const config = testConfig(dir, overrides);
  const session = await createSession(config);
  const full = { base_dir: project, questions: QUESTIONS, ...input };
  await writeJson(session, 'input.json', full);
  await collect(session, full, config);
  return { project, config, session };
}

test('build writes the documented state shape and request body', async (t) => {
  const { config, session } = await collected(t, {
    files: ['a.js', { path: 'b.js', label: 'the b file' }],
    context: 'Rules here.',
  });
  const body = await build(session, config);
  assert.deepEqual(await readJson(session, 'request.json'), body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.questions, QUESTIONS);
  assert.deepEqual(body.state, {
    context: 'Rules here.',
    files: [
      { path: 'a.js', content: 'const a = 1;\n' },
      { path: 'b.js', label: 'the b file', content: 'const b = 2;\n' },
    ],
  });
  const meta = await readJson(session, 'meta.json');
  assert.equal(meta.model, 'jev-latest');
  assert.ok(meta.estimate.state_tokens > 0);
});

test('context-only state omits files; files-only omits context', async (t) => {
  const a = await collected(t, { context: 'just text' });
  assert.deepEqual((await build(a.session, a.config)).state, { context: 'just text' });
  const b = await collected(t, { files: ['a.js'] });
  assert.equal('context' in (await build(b.session, b.config)).state, false);
});

test('per-call model overrides the configured one', async (t) => {
  const { config, session } = await collected(t, { context: 'x' });
  assert.equal((await build(session, config, { model: 'jev-1.13.0' })).model, 'jev-1.13.0');
  await assert.rejects(build(session, config, { model: '' }), (e) => e.type === 'invalid_input');
});

test('build reads the session copies, not the originals', async (t) => {
  const { project, config, session } = await collected(t, { files: ['a.js'] });
  await fs.writeFile(path.join(project, 'a.js'), 'CHANGED AFTER COLLECT');
  const body = await build(session, config);
  assert.equal(body.state.files[0].content, 'const a = 1;\n');
});

test('build fails with question errors before writing request.json', async (t) => {
  const { config, session } = await collected(t, { context: 'x', questions: { a: { type: 'nope', instructions: 'x' } } });
  await assert.rejects(build(session, config), (e) => e.type === 'invalid_question');
  await assert.rejects(fs.access(path.join(session.dir, 'request.json')));
});

test('context_too_large reports numbers and the largest files', async (t) => {
  const { config, session } = await collected(t, { files: ['a.js', 'big.js'] }, { max_input_tokens: 200 }, { 'big.js': 'x'.repeat(5000) });
  await assert.rejects(build(session, config), (e) => {
    assert.equal(e.type, 'context_too_large');
    assert.equal(e.details.max_input_tokens, 200);
    assert.ok(e.details.state_tokens > 200);
    assert.equal(e.details.largest_files[0].path, 'big.js');
    return true;
  });
  await assert.rejects(fs.access(path.join(session.dir, 'request.json')));
  assert.ok((await readJson(session, 'meta.json')).estimate.total_tokens > 0);
});

test('total-tokens limit is enforced separately', async (t) => {
  const { config, session } = await collected(t, { context: 'x' }, { max_total_tokens: 30 });
  const questions = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'y'.repeat(40) }]));
  const input = { ...(await readJson(session, 'input.json')), questions };
  await writeJson(session, 'input.json', input);
  await assert.rejects(build(session, config), (e) => e.type === 'context_too_large' && /all questions/.test(e.message));
});

test('questions are sent exactly as given, for both providers', async (t) => {
  const questions = {
    c: { type: 'choice', instructions: { case: 'x', question: 'which?' }, criteria: { one: 'first', two: null } },
    s: { type: 'score', instructions: 'x', criteria: ['low', { text: 'high' }] },
  };
  for (const provider of ['typesafe', 'openrouter']) {
    const { config, session } = await collected(t, { context: 'x', questions }, { provider, model: 'm' });
    assert.deepEqual((await build(session, config)).questions, questions);
  }
});
