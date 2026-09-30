import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VERSION } from '../src/constants.js';
import { inspect, install, location, render, status, uninstall } from '../src/skill.js';
import { isolatedEnv, runCli, tempDir, writeTree } from './helpers.js';

const SKILL_SRC = new URL('../skills/jev-answers/SKILL.md', import.meta.url);

async function cliEnv(t, extra = {}) {
  const dir = await tempDir(t);
  const home = path.join(dir, 'home');
  await fs.mkdir(home);
  const env = { ...isolatedEnv(dir, extra), HOME: home, PATH: path.join(dir, 'nobin') };
  const cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  return { dir, home, cwd, env, cli: (args, opts = {}) => runCli(args, { env, cwd, ...opts }) };
}

const skillFile = (base, dir) => path.join(base, dir, 'skills', 'jev-answers', 'SKILL.md');

test('SKILL.md frontmatter follows the Agent Skills rules', async () => {
  const text = await fs.readFile(SKILL_SRC, 'utf8');
  const head = /^---\n([\s\S]*?)\n---/.exec(text)[1];
  const name = /^name:\s*(.+)$/m.exec(head)[1].trim();
  const description = /^description:\s*(.+)$/m.exec(head)[1].trim();
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(name.length <= 64);
  assert.equal(name, path.basename(path.dirname(SKILL_SRC.pathname)));
  assert.ok(description.length >= 1 && description.length <= 1024, `description length ${description.length}`);
  assert.match(head, /source:\s*jev-answers/);
  assert.match(head, /version:\s*"__VERSION__"/);
});

test('render substitutes the package version', async () => {
  const text = await render();
  assert.ok(!text.includes('__VERSION__'));
  assert.match(text, new RegExp(`version: "${VERSION.replace(/\./g, '\\.')}"`));
});

test('install writes a real copy to each target and status reports it', async (t) => {
  const { home, cli, env } = await cliEnv(t);
  const result = await cli(['skill', 'install', '--target', 'claude,agents']);
  assert.equal(result.code, 0, result.stderr);
  for (const dir of ['.claude', '.agents']) {
    const file = skillFile(home, dir);
    assert.ok(result.stdout.includes(file));
    assert.ok((await fs.lstat(file)).isFile());
    assert.match(await fs.readFile(file, 'utf8'), new RegExp(`version: "${VERSION}"`));
  }
  const status = await cli(['skill', 'status']);
  assert.match(status.stdout, new RegExp(`~/.claude/skills/jev-answers\\s+installed v${VERSION} \\(current\\)`));
  assert.ok(env.HOME === home);
});

test('install without --target installs both when no agent is on PATH, only detected ones otherwise', async (t) => {
  const { dir, home, env, cli } = await cliEnv(t);
  assert.equal((await cli(['skill', 'install'])).code, 0);
  assert.ok(await fs.stat(skillFile(home, '.claude')));
  assert.ok(await fs.stat(skillFile(home, '.agents')));
  await cli(['skill', 'uninstall']);

  const bin = path.join(dir, 'bin');
  await writeTree(bin, { codex: '#!/bin/sh\n' });
  await fs.chmod(path.join(bin, 'codex'), 0o755);
  const result = await runCli(['skill', 'install'], { env: { ...env, PATH: bin } });
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(fs.stat(skillFile(home, '.claude')));
  assert.ok(await fs.stat(skillFile(home, '.agents')));
});

test('--project installs under the current directory', async (t) => {
  const { home, cwd, cli } = await cliEnv(t);
  const result = await cli(['skill', 'install', '--project', '--target', 'claude']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(await fs.stat(skillFile(cwd, '.claude')));
  await assert.rejects(fs.stat(skillFile(home, '.claude')));
  assert.match((await cli(['skill', 'status'])).stdout, /^\.claude\/skills\/jev-answers\s+installed/m);
  assert.equal((await cli(['skill', 'uninstall', '--project', '--target', 'claude'])).code, 0);
  await assert.rejects(fs.stat(skillFile(cwd, '.claude')));
});

test('our older version is upgraded; status shows outdated first', async (t) => {
  const { home, cli } = await cliEnv(t);
  await cli(['skill', 'install', '--target', 'claude']);
  const file = skillFile(home, '.claude');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(`version: "${VERSION}"`, 'version: "0.0.1"'));
  assert.match((await cli(['skill', 'status'])).stdout, /installed v0\.0\.1 \(outdated\)/);
  const again = await cli(['skill', 'install', '--target', 'claude']);
  assert.match(again.stdout, /^updated:/);
  assert.match(await fs.readFile(file, 'utf8'), new RegExp(`version: "${VERSION}"`));
});

test('a foreign skill is refused without --force and left alone on uninstall', async (t) => {
  const { home, cli } = await cliEnv(t);
  const file = skillFile(home, '.claude');
  const foreign = '---\nname: jev-answers\ndescription: mine\n---\nhand written\n';
  await writeTree(home, { '.claude/skills/jev-answers/SKILL.md': foreign, '.claude/skills/jev-answers/extra.md': 'keep' });

  const refused = await cli(['skill', 'install', '--target', 'claude']);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /not a jev-answers skill/);
  assert.equal(await fs.readFile(file, 'utf8'), foreign);
  assert.match((await cli(['skill', 'status'])).stdout, /foreign/);

  assert.equal((await cli(['skill', 'uninstall', '--target', 'claude'])).code, 1);
  assert.equal(await fs.readFile(file, 'utf8'), foreign);

  assert.equal((await cli(['skill', 'install', '--target', 'claude', '--force'])).code, 0);
  assert.match(await fs.readFile(file, 'utf8'), /source: jev-answers/);
});

test('uninstall removes only our file and keeps a folder that has other content', async (t) => {
  const { home, cli } = await cliEnv(t);
  await cli(['skill', 'install', '--target', 'claude']);
  await fs.writeFile(path.join(home, '.claude/skills/jev-answers/notes.txt'), 'mine');
  const result = await cli(['skill', 'uninstall', '--target', 'claude']);
  assert.match(result.stdout, /^removed:/);
  await assert.rejects(fs.stat(skillFile(home, '.claude')));
  assert.equal(await fs.readFile(path.join(home, '.claude/skills/jev-answers/notes.txt'), 'utf8'), 'mine');
  assert.match((await cli(['skill', 'uninstall', '--target', 'claude'])).stdout, /not installed/);
});

test('a symlinked SKILL.md is replaced, not written through', async (t) => {
  const { dir, home } = await cliEnv(t);
  const target = path.join(dir, 'elsewhere.md');
  await fs.writeFile(target, '---\nsource: jev-answers\nversion: "0.0.1"\n---\n');
  const loc = location('claude', { home });
  await fs.mkdir(loc.dir, { recursive: true });
  await fs.symlink(target, loc.file);
  await install(loc);
  assert.ok((await fs.lstat(loc.file)).isFile());
  assert.match(await fs.readFile(target, 'utf8'), /0\.0\.1/);
  assert.equal((await inspect(loc)).state, 'ours');
  assert.equal(await status(loc), `installed v${VERSION} (current)`);
  assert.equal(await uninstall(loc), 'removed');
});

test('show prints the rendered skill; bad usage exits 2', async (t) => {
  const { cli } = await cliEnv(t);
  const shown = await cli(['skill', 'show']);
  assert.equal(shown.stdout, await render());
  assert.equal((await cli(['skill'])).code, 2);
  assert.equal((await cli(['skill', 'install', '--target', 'vim'])).code, 2);
});

test('setup --yes --skill installs; without the flag it does not', async (t) => {
  const { home, cli } = await cliEnv(t);
  assert.equal((await cli(['setup', '--yes', '--api-key', 'abc'])).code, 0);
  await assert.rejects(fs.stat(skillFile(home, '.claude')));
  const result = await cli(['setup', '--yes', '--api-key', 'abc', '--skill', 'claude,agents']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(await fs.stat(skillFile(home, '.claude')));
  assert.ok(await fs.stat(skillFile(home, '.agents')));
  assert.equal((await cli(['setup', '--yes', '--skill', 'nope'])).code, 2);
});

test('interactive setup offers the skill for detected agents and says Update when ours exists', async (t) => {
  const { dir, home, env } = await cliEnv(t);
  const bin = path.join(dir, 'bin');
  await writeTree(bin, { claude: '#!/bin/sh\nexit 0\n' });
  await fs.chmod(path.join(bin, 'claude'), 0o755);
  const run = () => runCli(['setup'], { env: { ...env, PATH: bin }, input: 'typesafe\nkey-1234567890abcdef\n\n\nn\ny\n' });
  const first = await run();
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Install the jev-answers skill for Claude Code \(~\/\.claude\/skills\/jev-answers\)\? It teaches the agent when and how to use jev_ask\. \[y\/N\]/);
  assert.ok(await fs.stat(skillFile(home, '.claude')));
  const second = await run();
  assert.match(second.stdout, /Update the jev-answers skill for Claude Code/);
});

test('doctor lists the skill locations', async (t) => {
  const { cli } = await cliEnv(t);
  assert.match((await cli(['doctor'])).stdout, /skill ~\/\.claude\/skills\/jev-answers: not installed/);
  await cli(['skill', 'install', '--target', 'agents']);
  const doctor = await cli(['doctor']);
  assert.match(doctor.stdout, new RegExp(`skill ~/\\.agents/skills/jev-answers: installed v${VERSION} \\(current\\)`));
});

test('MCP server instructions carry the "when"', async () => {
  const { createHandler } = await import('../src/mcp/server.js');
  const reply = await createHandler({ send() {} }).handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const text = reply.result.instructions;
  assert.match(text, /^jev-answers has one tool, jev_ask\./);
  assert.match(text, /many questions per call are fine\.$/);
  assert.match(text, /Do not use it for open-ended review or explanations\./);
});

test('package ships the skills folder and is version 0.1.3', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('skills'));
  assert.equal(pkg.version, '0.1.3');
});
