import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NAME, VERSION } from './constants.js';
import { ErrorType, JevAnswersError } from './errors.js';
import { onPath } from './cli/launch.js';

const SOURCE = new URL('../skills/jev-answers/SKILL.md', import.meta.url);

// Both directories are documented user-level skill locations; OpenCode reads either.
export const TARGETS = {
  claude: { dir: '.claude', label: 'Claude Code', readers: 'Claude Code, OpenCode' },
  agents: { dir: '.agents', label: 'Codex / OpenCode / other agents', readers: 'Codex, OpenCode, other Agent Skills clients' },
};

export function parseTargets(text) {
  const names = String(text).split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = names.filter((n) => !TARGETS[n]);
  if (!names.length || unknown.length) {
    throw new JevAnswersError(ErrorType.INVALID_INPUT, `Unknown skill target "${unknown[0] ?? text}". Use: ${Object.keys(TARGETS).join(', ')}.`);
  }
  return [...new Set(names)];
}

/** Targets whose agent is installed. May be empty. */
export function detectTargets(env = process.env) {
  const found = [];
  if (onPath('claude', env)) found.push('claude');
  if (onPath('codex', env) || onPath('opencode', env)) found.push('agents');
  return found;
}

/** @returns {{target: string, dir: string, file: string, display: string}} */
export function location(target, { project = false, home = os.homedir(), cwd = process.cwd() } = {}) {
  const base = project ? cwd : home;
  const dir = path.join(base, TARGETS[target].dir, 'skills', NAME);
  const shown = project ? path.join('.', TARGETS[target].dir, 'skills', NAME) : path.join('~', TARGETS[target].dir, 'skills', NAME);
  return { target, dir, file: path.join(dir, 'SKILL.md'), display: shown };
}

export async function render() {
  return (await fs.readFile(SOURCE, 'utf8')).replaceAll('__VERSION__', VERSION);
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match ? match[1] : '';
}

/** @returns {Promise<{state: 'missing'|'ours'|'foreign', version?: string}>} */
export async function inspect(loc) {
  let text;
  try {
    text = await fs.readFile(loc.file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing' };
    throw err;
  }
  const head = frontmatter(text);
  if (!/^\s*source:\s*["']?jev-answers["']?\s*$/m.test(head)) return { state: 'foreign' };
  return { state: 'ours', version: /^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(head)?.[1] };
}

const conflict = (loc) =>
  new JevAnswersError(
    ErrorType.SKILL_CONFLICT,
    `${loc.file} exists and is not a jev-answers skill. Use --force to overwrite it.`,
    { path: loc.file },
  );

/** Write a copy (never a symlink: the npx cache can disappear). @returns 'installed' | 'updated' */
export async function install(loc, { force = false } = {}) {
  const { state } = await inspect(loc);
  if (state === 'foreign' && !force) throw conflict(loc);
  await fs.mkdir(loc.dir, { recursive: true });
  await fs.rm(loc.file, { force: true }); // a pre-existing symlink must not be written through
  await fs.writeFile(loc.file, await render(), { mode: 0o644 });
  return state === 'ours' || state === 'foreign' ? 'updated' : 'installed';
}

/** Remove our SKILL.md (and its folder if that leaves it empty). @returns 'removed' | 'absent' */
export async function uninstall(loc) {
  const { state } = await inspect(loc);
  if (state === 'missing') return 'absent';
  if (state === 'foreign') {
    throw new JevAnswersError(ErrorType.SKILL_CONFLICT, `${loc.file} is not a jev-answers skill; leaving it alone.`, { path: loc.file });
  }
  await fs.rm(loc.file);
  await fs.rmdir(loc.dir).catch(() => {});
  return 'removed';
}

/** Human-readable status for one location. */
export async function status(loc) {
  const { state, version } = await inspect(loc);
  if (state === 'missing') return 'not installed';
  if (state === 'foreign') return 'foreign (not a jev-answers skill)';
  return `installed v${version ?? '?'} (${version === VERSION ? 'current' : 'outdated'})`;
}
