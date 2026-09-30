import { loadConfig } from '../config.js';
import { ErrorType, JevAnswersError } from '../errors.js';
import { pruneSessions } from '../session.js';
import { parse } from './args.js';
import { createPrompter } from './prompt.js';
import { out } from './output.js';

export async function run(argv) {
  const { values } = parse(argv, { 'older-than': { type: 'string' }, yes: { type: 'boolean', default: false } }, { allowPositionals: false });
  const match = /^(\d+)d?$/.exec(values['older-than'] ?? '');
  if (!match) throw new JevAnswersError(ErrorType.INVALID_INPUT, 'Usage: jev-answers prune --older-than <N>d [--yes]');
  const config = loadConfig().values;
  const olderThanDays = Number(match[1]);

  const candidates = await pruneSessions(config, { olderThanDays, dryRun: true });
  if (!candidates.length) {
    out(`No sessions older than ${olderThanDays} days.`);
    return 0;
  }
  if (!values.yes) {
    const prompt = await createPrompter();
    const answer = await prompt.ask(`Delete ${candidates.length} session(s) older than ${olderThanDays} days? [y/N] `);
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      out('Nothing deleted.');
      return 0;
    }
  }
  const removed = await pruneSessions(config, { olderThanDays });
  out(`Deleted ${removed.length} session(s).`);
  return 0;
}
