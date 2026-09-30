import { ErrorType, JevAnswersError } from '../errors.js';
import { loadConfig } from '../config.js';
import { resend } from '../pipeline.js';
import { resolveSession } from '../session.js';
import { parse } from './args.js';
import { printJson } from './output.js';

export async function run(argv) {
  const { positionals } = parse(argv, {});
  if (positionals.length !== 1) throw new JevAnswersError(ErrorType.INVALID_INPUT, 'Usage: jev-answers resend <session|latest>');
  const { values: config } = loadConfig();
  const result = await resend(await resolveSession(config, positionals[0]), { config });
  printJson(result);
  return result.status === 'ok' ? 0 : 1;
}
