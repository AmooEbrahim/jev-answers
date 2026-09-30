import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { collect } from '../src/stages/collect.js';
import { isSecretFile } from '../src/stages/secrets.js';
import { createSession, readJson } from '../src/session.js';
import { tempDir, testConfig, writeTree } from './helpers.js';

async function setup(t, tree = {}, overrides = {}) {
  const dir = await tempDir(t);
  const project = path.join(dir, 'project');
  await writeTree(project, {
    'src/a.js': 'const a = 1;\n',
    'src/b.js': 'const b = 2;\n',
    'src/deep/c.txt': 'c',
    'README.md': '# hi',
    ...tree,
  });
  const config = testConfig(dir, overrides);
  const session = await createSession(config);
  return { dir, project, config, session };
}

const expectType = (type) => (e) => e.type === type;

test('explicit files are copied with relative layout and hashed', async (t) => {
  const { project, config, session } = await setup(t);
  const manifest = await collect(session, { base_dir: project, files: ['src/a.js', { path: 'README.md', label: 'readme' }], context: 'x' }, config);
  assert.deepEqual(manifest.files.map((f) => f.display_path), ['src/a.js', 'README.md']);
  assert.equal(manifest.files[1].label, 'readme');
  assert.equal(manifest.files[0].copy, 'inputs/src/a.js');
  assert.equal(await fs.readFile(path.join(session.dir, 'inputs/src/a.js'), 'utf8'), 'const a = 1;\n');
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readJson(session, 'manifest.json'), manifest);
});

test('relative paths resolve against the process cwd without base_dir', async (t) => {
  const { project, config, session } = await setup(t);
  const previous = process.cwd();
  process.chdir(project);
  t.after(() => process.chdir(previous));
  const manifest = await collect(session, { files: ['README.md'] }, config);
  assert.equal(manifest.files[0].display_path, 'README.md');
});

test('glob and directory expansion, with de-duplication', async (t) => {
  const { project, config, session } = await setup(t);
  const manifest = await collect(session, { base_dir: project, files: ['src/**/*.js', 'src', 'src/a.js', path.join(project, 'src/a.js')] }, config);
  assert.deepEqual(manifest.files.map((f) => f.display_path).sort(), ['src/a.js', 'src/b.js', 'src/deep/c.txt']);
});

test('expansion skips ignored dirs, binaries and secrets, and records why', async (t) => {
  const { project, config, session } = await setup(t, {
    'node_modules/pkg/index.js': 'x',
    '.git/config': 'x',
    'src/.env': 'SECRET=1',
    'src/.env.example': 'SECRET=',
    'src/key.pem': 'k',
  });
  await fs.writeFile(path.join(project, 'src/logo.png'), Buffer.from([0x89, 0x50, 0, 1]));
  const manifest = await collect(session, { base_dir: project, files: ['.'] }, config);
  const names = manifest.files.map((f) => f.display_path);
  assert.ok(!names.some((n) => n.startsWith('node_modules') || n.startsWith('.git/')));
  const reasons = Object.fromEntries(manifest.skipped.map((s) => [path.basename(s.source), s.reason]));
  assert.equal(reasons['.env'], 'hidden'); // dot files are skipped before the secret check
  assert.equal(reasons['.env.example'], 'hidden');
  assert.equal(reasons['key.pem'], 'secret file');
  assert.equal(reasons['logo.png'], 'binary file');
});

test('glob expansion skips ignored directories too', async (t) => {
  const { project, config, session } = await setup(t, { 'node_modules/pkg/index.js': 'x', 'vendor/v.js': 'x' });
  const manifest = await collect(session, { base_dir: project, files: ['**/*.js'] }, config);
  assert.deepEqual(manifest.files.map((f) => f.display_path).sort(), ['src/a.js', 'src/b.js']);
});

test('explicitly named problem files are errors, not skips', async (t) => {
  const { project, config, session } = await setup(t, { '.env': 'A=1' });
  await fs.writeFile(path.join(project, 'bin.dat'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(project, 'big.txt'), 'x'.repeat(200));
  const small = { ...config, max_file_bytes: 100 };
  const run = (files, cfg = config) => collect(session, { base_dir: project, files }, cfg);
  await assert.rejects(run(['missing.js']), expectType('file_not_found'));
  await assert.rejects(run(['.env']), expectType('secret_file'));
  await assert.rejects(run(['bin.dat']), expectType('binary_file'));
  await assert.rejects(run(['big.txt'], small), expectType('file_too_large'));
  await assert.rejects(run(['nothing/**/*.zzz']), expectType('file_not_found'));
});

test('allow_secret_files lets secrets through', async (t) => {
  const { project, config, session } = await setup(t, { '.env': 'A=1' }, { allow_secret_files: true });
  const manifest = await collect(session, { base_dir: project, files: ['.env'] }, config);
  assert.equal(manifest.files.length, 1);
});

test('max_files is enforced', async (t) => {
  const { project, config, session } = await setup(t, {}, { max_files: 2 });
  await assert.rejects(collect(session, { base_dir: project, files: ['src'] }, config), expectType('too_many_files'));
});

test('files outside base_dir go under inputs/_external', async (t) => {
  const { dir, project, config, session } = await setup(t);
  const outside = path.join(dir, 'other', 'notes.txt');
  await writeTree(dir, { 'other/notes.txt': 'n' });
  const manifest = await collect(session, { base_dir: project, files: [outside] }, config);
  assert.equal(manifest.files[0].display_path, outside);
  assert.equal(manifest.files[0].copy, path.posix.join('inputs/_external', outside.replace(/^\/+/, '')));
  assert.equal(await fs.readFile(path.join(session.dir, manifest.files[0].copy), 'utf8'), 'n');
});

test('input shape validation', async (t) => {
  const { project, config, session } = await setup(t);
  const run = (input) => collect(session, input, config);
  await assert.rejects(run({}), expectType('invalid_input'));
  await assert.rejects(run({ files: 'a.js' }), expectType('invalid_input'));
  await assert.rejects(run({ files: [42] }), expectType('invalid_input'));
  await assert.rejects(run({ files: [{ path: 'a', label: 3 }] }), expectType('invalid_input'));
  await assert.rejects(run({ context: 5 }), expectType('invalid_input'));
  await assert.rejects(run({ context: 'x', base_dir: path.join(project, 'nope') }), expectType('file_not_found'));
  const manifest = await run({ context: 'only context' });
  assert.deepEqual(manifest.files, []);
});

test('secret file patterns', () => {
  for (const yes of ['.env', '.ENV', '.env.local', 'a/server.pem', 'k.KEY', 'x.p12', 'x.pfx', 'x.jks', 'x.keystore', 'x.kdbx',
    'id_rsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '/home/u/.aws/credentials']) {
    assert.equal(isSecretFile(yes), true, yes);
  }
  for (const no of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'id_rsa.pub', 'credentials', 'src/app.js', 'keyboard.js']) {
    assert.equal(isSecretFile(no), false, no);
  }
});
