import { parseArgs } from 'node:util';
import { ErrorType, JevAnswersError } from '../errors.js';

/** Strict option parsing that reports problems as usage errors. */
export function parse(argv, options, { allowPositionals = true } = {}) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (err) {
    throw new JevAnswersError(ErrorType.INVALID_INPUT, err.message);
  }
}
