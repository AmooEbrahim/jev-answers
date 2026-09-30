import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactUrl } from './config.js';
import { VERSION } from './constants.js';
import { ErrorType, JevAnswersError } from './errors.js';

const SESSION_ID = /^\d{8}-\d{6}-/;
const DAY_MS = 86_400_000;

const pad = (n, width = 2) => String(n).padStart(width, '0');

export function slugify(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

/** ISO 8601 in local time with numeric offset, e.g. 2026-09-30T16:45:12+03:30. */
export function isoLocal(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function stamp(date) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export const sessionsDir = (config) => path.join(config.home, 'sessions');

async function pointLatestAt(root, id) {
  const tmp = path.join(root, `.latest-${process.pid}-${randomBytes(2).toString('hex')}`);
  try {
    await fs.symlink(id, tmp);
    await fs.rename(tmp, path.join(root, 'latest'));
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * @param {object} config
 * @param {{label?: string, now?: Date}} [opts]
 * @returns {Promise<{id: string, dir: string}>}
 */
export async function createSession(config, { label, now = new Date() } = {}) {
  const root = sessionsDir(config);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const slug = slugify(label);
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = [stamp(now), slug, randomBytes(2).toString('hex')].filter(Boolean).join('-');
    const dir = path.join(root, id);
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw new JevAnswersError(ErrorType.SESSION, `Cannot create session folder ${dir}: ${err.message}`);
    }
    const session = { id, dir };
    await writeJson(session, 'meta.json', {
      id,
      label: label ?? null,
      created_at: isoLocal(now),
      jev_answers_version: VERSION,
      provider: config.provider,
      base_url: redactUrl(config.base_url),
      model: config.model,
      status: 'running',
    });
    await pointLatestAt(root, id);
    if (config.retention_days > 0) {
      await pruneSessions(config, { olderThanDays: config.retention_days, keep: id }).catch(() => {});
    }
    return session;
  }
  throw new JevAnswersError(ErrorType.SESSION, 'Could not find a free session id.');
}

export const sessionFile = (session, ...parts) => path.join(session.dir, ...parts);

export async function writeJson(session, name, data) {
  await fs.writeFile(sessionFile(session, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export async function readJson(session, name) {
  let text;
  try {
    text = await fs.readFile(sessionFile(session, name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new JevAnswersError(ErrorType.MISSING_ARTIFACT, `${name} is missing in session ${session.id}.`, { file: name });
    }
    throw err;
  }
  return JSON.parse(text);
}

/** Merge a patch into meta.json; `stages` is merged one level deep, other keys are replaced. */
export async function updateMeta(session, patch) {
  const meta = await readJson(session, 'meta.json');
  for (const [key, value] of Object.entries(patch)) {
    meta[key] = key === 'stages' ? { ...meta.stages, ...value } : value; // http describes the last attempt only
  }
  await writeJson(session, 'meta.json', meta);
  return meta;
}

export async function listSessions(config) {
  let names;
  try {
    names = await fs.readdir(sessionsDir(config), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const sessions = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const dir = path.join(sessionsDir(config), entry.name);
    sessions.push({ id: entry.name, dir, born: (await fs.stat(dir)).birthtimeMs });
  }
  // Names sort chronologically; the random suffix only matters within one second,
  // where the folder creation time breaks the tie. Newest first.
  const stamp = (s) => s.id.slice(0, 15);
  sessions.sort((a, b) => (stamp(a) !== stamp(b) ? (stamp(a) < stamp(b) ? 1 : -1) : b.born - a.born || (a.id < b.id ? 1 : -1)));
  for (const session of sessions) delete session.born;
  for (const session of sessions) {
    session.meta = await readJson(session, 'meta.json').catch(() => null);
  }
  return sessions;
}

/** Accepts "latest", a full id, a unique id fragment, or a path to a session folder. */
export async function resolveSession(config, ref) {
  const sessions = await listSessions(config);
  if (ref === 'latest') {
    if (!sessions.length) throw new JevAnswersError(ErrorType.SESSION, `No sessions found in ${sessionsDir(config)}.`);
    return sessions[0];
  }
  const exact = sessions.find((s) => s.id === ref);
  if (exact) return exact;
  const partial = sessions.filter((s) => s.id.includes(ref));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new JevAnswersError(ErrorType.SESSION, `"${ref}" matches ${partial.length} sessions; be more specific.`);
  }
  const dir = path.resolve(ref);
  const stat = await fs.stat(dir).catch(() => null);
  if (stat?.isDirectory()) return { id: path.basename(dir), dir };
  throw new JevAnswersError(ErrorType.SESSION, `Session "${ref}" not found.`);
}

/**
 * Delete sessions older than the given number of days.
 * @returns {Promise<string[]>} ids that were (or, with dryRun, would be) removed
 */
export async function pruneSessions(config, { olderThanDays, keep, dryRun = false, now = Date.now() }) {
  const cutoff = now - olderThanDays * DAY_MS;
  const removed = [];
  for (const session of await listSessions(config)) {
    if (session.id === keep) continue;
    const created = Date.parse(session.meta?.created_at ?? '');
    const time = Number.isNaN(created) ? (await fs.stat(session.dir)).mtimeMs : created;
    if (time >= cutoff) continue;
    if (!dryRun) await fs.rm(session.dir, { recursive: true, force: true });
    removed.push(session.id);
  }
  return removed;
}
