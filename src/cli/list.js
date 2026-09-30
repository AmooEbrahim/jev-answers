import { ErrorType, JevAnswersError } from '../errors.js';
import { loadConfig } from '../config.js';
import { listSessions } from '../session.js';
import { parse } from './args.js';
import { out } from './output.js';

export async function run(argv) {
  const { values } = parse(argv, { limit: { type: 'string', default: '20' } }, { allowPositionals: false });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new JevAnswersError(ErrorType.INVALID_INPUT, '--limit must be a positive integer.');

  const sessions = (await listSessions(loadConfig().values)).slice(0, limit);
  if (!sessions.length) {
    out('No sessions yet.');
    return 0;
  }
  const rows = sessions.map(({ id, meta }) => [
    id,
    meta?.status ?? '?',
    meta ? `${meta.provider}/${meta.model}` : '?',
    meta?.label ?? '',
  ]);
  const widths = [0, 1, 2].map((col) => Math.max(...rows.map((row) => row[col].length)));
  for (const row of rows) {
    out(row.map((cell, col) => (col < 3 ? cell.padEnd(widths[col]) : cell)).join('  ').trimEnd());
  }
  return 0;
}
