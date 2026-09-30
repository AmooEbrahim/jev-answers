import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorType, JevAnswersError } from '../errors.js';
import { sessionFile, writeJson } from '../session.js';
import { copyPath, expandGlob, hasGlobChars, looksBinary, walk } from './files.js';
import { isSecretFile } from './secrets.js';

const fail = (type, message, details) => new JevAnswersError(type, message, details);
const INPUT_KEYS = new Set(['files', 'base_dir', 'context', 'questions', 'label', 'model']);

function checkKeys(input) {
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) {
      throw fail(ErrorType.INVALID_INPUT, `Unknown input field "${key}". Allowed: ${[...INPUT_KEYS].join(', ')}.`, { field: key });
    }
  }
}

function normalizeEntries(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw fail(ErrorType.INVALID_INPUT, '"files" must be an array.');
  return files.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) return { spec: entry };
    if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim()) {
      if (entry.label !== undefined && typeof entry.label !== 'string') {
        throw fail(ErrorType.INVALID_INPUT, `files[${index}].label must be a string.`);
      }
      return { spec: entry.path, label: entry.label };
    }
    throw fail(ErrorType.INVALID_INPUT, `files[${index}] must be a path string or {path, label?}.`);
  });
}

async function resolveBaseDir(baseDir) {
  if (baseDir === undefined) return process.cwd();
  if (typeof baseDir !== 'string' || !baseDir.trim()) {
    throw fail(ErrorType.INVALID_INPUT, '"base_dir" must be a non-empty string.');
  }
  const resolved = path.resolve(baseDir);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw fail(ErrorType.FILE_NOT_FOUND, `base_dir is not a directory: ${resolved}`);
  return resolved;
}

/**
 * Turn one entry into candidate absolute paths. `explicit` files must never be skipped silently.
 * Directory and glob expansion never follow symlinks; they report them in `symlinks`.
 */
async function expandEntry(spec, baseDir) {
  const abs = path.resolve(baseDir, spec);
  const stat = await fs.stat(abs).catch(() => null);
  if (stat?.isDirectory()) return { ...(await walk(abs)), explicit: false };
  if (stat) return { files: [abs], symlinks: [], skipped: [], explicit: true };
  if (hasGlobChars(spec)) return { ...(await expandGlob(spec, baseDir)), explicit: false };
  throw fail(ErrorType.FILE_NOT_FOUND, `File not found: ${abs}`, { path: abs });
}

async function realpathOrSelf(p) {
  return fs.realpath(p).catch(() => p);
}

/** Returns a skip/error reason for a file, or the buffer when it is fine to collect. */
async function inspect(abs, config) {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    return { reason: 'unreadable', type: ErrorType.FILE_UNREADABLE, message: err.message };
  }
  if (!stat.isFile()) return { reason: 'not a regular file', type: ErrorType.FILE_UNREADABLE };
  // A link named "config.txt" may point at ".env", so check the target's name too.
  if (!config.allow_secret_files && (isSecretFile(abs) || isSecretFile(await realpathOrSelf(abs)))) {
    return { reason: 'secret file', type: ErrorType.SECRET_FILE };
  }
  if (stat.size > config.max_file_bytes) {
    return { reason: `too large (${stat.size} bytes > ${config.max_file_bytes})`, type: ErrorType.FILE_TOO_LARGE };
  }
  let buffer;
  try {
    buffer = await fs.readFile(abs);
  } catch (err) {
    return { reason: 'unreadable', type: ErrorType.FILE_UNREADABLE, message: err.message };
  }
  if (looksBinary(buffer)) return { reason: 'binary file', type: ErrorType.BINARY_FILE };
  return { buffer };
}

/**
 * Stage 1: validate the input, copy every file into the session and write manifest.json.
 * @returns {Promise<object>} the manifest
 */
export async function collect(session, input, config) {
  checkKeys(input);
  const entries = normalizeEntries(input.files);
  if (input.context !== undefined && typeof input.context !== 'string') {
    throw fail(ErrorType.INVALID_INPUT, '"context" must be a string.');
  }
  if (!entries.length && !input.context?.trim()) {
    throw fail(ErrorType.INVALID_INPUT, 'Provide at least one of "files" or "context".');
  }
  const baseDir = await resolveBaseDir(input.base_dir);

  const chosen = new Map(); // absolute path -> {label, buffer}
  const skipped = [];
  const skippedPaths = new Set();
  const skip = (source, reason) => {
    if (skippedPaths.has(source)) return;
    skippedPaths.add(source);
    skipped.push({ source, reason });
  };
  for (const { spec, label } of entries) {
    const { files: paths, symlinks, skipped: notes, explicit } = await expandEntry(spec, baseDir);
    if (!paths.length && !symlinks.length && !notes.length) throw fail(ErrorType.FILE_NOT_FOUND, `"${spec}" matched no files.`, { pattern: spec });
    for (const link of symlinks) skip(link, 'symlink');
    for (const note of notes) skip(note.source, note.reason);
    for (const abs of paths) {
      const existing = chosen.get(abs);
      if (existing) {
        if (label && !existing.label) existing.label = label;
        continue;
      }
      // Explicit files are always re-inspected, so an earlier glob skip cannot hide a problem.
      if (!explicit && skippedPaths.has(abs)) continue;
      const result = await inspect(abs, config);
      if (result.reason && explicit) {
        throw fail(result.type, `${abs}: ${result.message ?? result.reason}`, { path: abs });
      }
      if (result.reason) {
        skip(abs, result.reason);
        continue;
      }
      chosen.set(abs, { label, buffer: result.buffer });
      if (chosen.size > config.max_files) {
        throw fail(ErrorType.TOO_MANY_FILES, `More than ${config.max_files} files selected; narrow the list.`, {
          max_files: config.max_files,
        });
      }
    }
  }
  if (!chosen.size && !input.context?.trim()) {
    const reasons = [...new Set(skipped.map((s) => s.reason))].join(', ');
    throw fail(
      ErrorType.INVALID_INPUT,
      `Nothing to send: all ${skipped.length} candidate file(s) were skipped (${reasons || 'none matched'}) and there is no "context".`,
      { skipped },
    );
  }

  const files = [];
  for (const [abs, { label, buffer }] of chosen) {
    const { inside, rel } = copyPath(abs, baseDir);
    const copy = path.join('inputs', rel);
    await fs.mkdir(path.dirname(sessionFile(session, copy)), { recursive: true, mode: 0o700 });
    await fs.writeFile(sessionFile(session, copy), buffer, { mode: 0o600 });
    const entry = {
      source: abs,
      copy: copy.split(path.sep).join('/'),
      display_path: inside ? rel.split(path.sep).join('/') : abs,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
    if (label) entry.label = label;
    files.push(entry);
  }

  const manifest = { base_dir: baseDir, files, skipped };
  await writeJson(session, 'manifest.json', manifest);
  return manifest;
}
