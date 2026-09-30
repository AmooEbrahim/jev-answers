import fs from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { ErrorType, JevAnswersError } from '../errors.js';
import { resolveSession, sessionFile } from '../session.js';
import { parse } from './args.js';
import { out } from './output.js';

export async function run(argv) {
  const { values, positionals } = parse(argv, { path: { type: 'boolean', default: false } });
  if (positionals.length !== 1) throw new JevAnswersError(ErrorType.INVALID_INPUT, 'Usage: jev-answers show <session|latest> [--path]');
  const session = await resolveSession(loadConfig().values, positionals[0]);
  if (values.path) {
    out(session.dir);
    return 0;
  }
  for (const name of ['response.json', 'error.json']) {
    try {
      process.stdout.write(await fs.readFile(sessionFile(session, name), 'utf8'));
      return name === 'response.json' ? 0 : 1;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw new JevAnswersError(ErrorType.MISSING_ARTIFACT, `Session ${session.id} has neither response.json nor error.json (still running?).`);
}
