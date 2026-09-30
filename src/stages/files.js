import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorType, JevAnswersError } from '../errors.js';

export const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', '.next',
  '.venv', 'venv', '__pycache__', 'coverage', '.jev-answers',
]);

export const hasGlobChars = (text) => /[*?[{]/.test(text);

const toPosix = (p) => p.split(path.sep).join('/');

export const MAX_VISITED_ENTRIES = 20_000;
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ENOENT']);

/**
 * Recursively list files under a directory. Symlinks (to files or directories) are never
 * followed; they are returned separately so callers can report them. Directories in
 * IGNORED_DIRS are not entered. Problems are reported in `skipped`, never thrown.
 * @param {string} dir
 * @param {{maxDepth?: number, allowHidden?: (isDir: boolean, depth: number) => boolean}} [opts]
 *   maxDepth: deepest directory level to enter (0 = only `dir` itself).
 *   allowHidden: may an entry whose name starts with "." be used? Default: no.
 * @returns {Promise<{files: string[], symlinks: string[], skipped: {source: string, reason: string, dir?: boolean}[]}>}
 */
export async function walk(dir, { maxDepth = Infinity, allowHidden = () => false } = {}) {
  const files = [];
  const symlinks = [];
  const skipped = [];
  let visited = 0;
  const visit = async (current, depth) => {
    let entries;
    try {
      entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch (err) {
      if (!UNREADABLE.has(err.code)) throw err;
      skipped.push({ source: current, reason: 'unreadable', dir: true });
      return;
    }
    for (const entry of entries) {
      if (++visited > MAX_VISITED_ENTRIES) {
        throw new JevAnswersError(
          ErrorType.INVALID_INPUT,
          `More than ${MAX_VISITED_ENTRIES} entries visited under ${dir}; narrow the glob or directory.`,
          { path: dir },
        );
      }
      const full = path.join(current, entry.name);
      const isDir = entry.isDirectory();
      if (entry.name.startsWith('.') && !entry.isSymbolicLink() && !allowHidden(isDir, depth)) {
        skipped.push({ source: full, reason: 'hidden', dir: isDir });
        continue;
      }
      if (entry.isSymbolicLink()) symlinks.push(full);
      else if (isDir) {
        if (!IGNORED_DIRS.has(entry.name) && depth < maxDepth) await visit(full, depth + 1);
      } else if (entry.isFile()) files.push(full);
    }
  };
  await visit(dir, 0);
  return { files, symlinks, skipped };
}

/** Find the closing brace that matches the "{" at `start`, or -1. */
function closingBrace(glob, start) {
  let depth = 0;
  for (let i = start; i < glob.length; i++) {
    if (glob[i] === '\\') i++;
    else if (glob[i] === '{') depth++;
    else if (glob[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function splitAlternatives(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; } else current += ch;
  }
  return [...parts, current];
}

const escapeRegExp = (ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Translate a glob (`**`, `*`, `?`, `[...]`, `{a,b}`) into a regex source; `/` separates segments. */
function globSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) out += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (ch === '{') {
      const end = closingBrace(glob, i);
      if (end === -1) out += '\\{';
      else {
        out += `(?:${splitAlternatives(glob.slice(i + 1, end)).map(globSource).join('|')})`;
        i = end;
      }
    } else if (ch === '\\' && i + 1 < glob.length) out += escapeRegExp(glob[++i]);
    else out += escapeRegExp(ch);
  }
  return out;
}

export function globToRegExp(glob, literalPrefix = '') {
  return new RegExp(`^${escapeRegExp(literalPrefix)}${globSource(glob)}$`);
}

/**
 * Expand a glob (absolute, or relative to `cwd`) by walking from its static prefix.
 * @returns {Promise<{files: string[], symlinks: string[]}>} matches only
 */
export async function expandGlob(pattern, cwd) {
  const relative = !path.isAbsolute(pattern);
  // "src/**/" means the same as "src/**".
  const normalized = path.posix.normalize(toPosix(pattern)).replace(/(?<=.)\/+$/, '');
  const segments = normalized.split('/');
  const staticParts = segments.slice(0, Math.max(0, segments.findIndex(hasGlobChars)));
  const root = relative ? path.resolve(cwd, ...staticParts) : path.resolve(staticParts.join('/') || '/');
  // The literal root is escaped, so glob characters in a directory name are harmless.
  const rootPrefix = toPosix(root).replace(/\/?$/, '/');
  const matcher = globToRegExp(segments.slice(staticParts.length).join('/'), rootPrefix);
  // A symlink anywhere in the static prefix would lead the walk outside the tree.
  let probe = relative ? path.resolve(cwd) : path.parse(root).root;
  for (const part of path.relative(probe, root).split(path.sep).filter(Boolean)) {
    probe = path.join(probe, part);
    const info = await fs.lstat(probe).catch(() => null);
    if (info?.isSymbolicLink()) return { files: [], symlinks: [probe], skipped: [] };
  }
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) return { files: [], symlinks: [], skipped: [] };
  const rest = segments.slice(staticParts.length);
  // Segments are only aligned with directory levels up to the first "**" or brace group.
  const variableAt = rest.findIndex((seg) => /\*\*|[{}]/.test(seg));
  const startsWithDot = (seg) => seg?.startsWith('.');
  const opts = {
    // Without "**" or braces, a match can be at most rest.length levels deep.
    maxDepth: variableAt === -1 ? rest.length - 1 : Infinity,
    allowHidden: (isDir, depth) => {
      if (!isDir) return startsWithDot(rest.at(-1));
      if (variableAt === -1 || depth < variableAt) return startsWithDot(rest[depth]);
      return rest.slice(variableAt + 1, -1).some(startsWithDot);
    },
  };
  const found = await walk(root, opts);
  const keep = (list) => list.filter((p) => matcher.test(toPosix(p))).sort();
  // Hidden files only matter when they would have matched; directories and problems always do.
  const skipped = found.skipped.filter((s) => s.dir || matcher.test(toPosix(s.source)));
  return { files: keep(found.files), symlinks: keep(found.symlinks), skipped };
}

/** Bytes 0..8K containing NUL is our definition of "binary". */
export function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

/** Where a collected file is stored inside the session's inputs/ folder. */
export function copyPath(absPath, baseDir) {
  const rel = path.relative(baseDir, absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { inside: true, rel };
  const external = absPath.replace(/^([A-Za-z]):/, '$1').replace(/^[\\/]+/, '');
  return { inside: false, rel: path.join('_external', external) };
}
