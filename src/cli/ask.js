import fs from 'node:fs/promises';
import { ErrorType, JevAnswersError } from '../errors.js';
import { ask } from '../pipeline.js';
import { parse } from './args.js';
import { printJson } from './output.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function run(argv) {
  const { positionals } = parse(argv, {});
  const [source] = positionals;
  if (!source && process.stdin.isTTY) {
    throw new JevAnswersError(ErrorType.INVALID_INPUT, 'Usage: jev-answers ask <file.json | ->  (or pipe JSON on stdin)');
  }
  let text;
  try {
    text = source && source !== '-' ? await fs.readFile(source, 'utf8') : await readStdin();
  } catch (err) {
    throw new JevAnswersError(ErrorType.INVALID_INPUT, `Cannot read ${source}: ${err.message}`);
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch (err) {
    throw new JevAnswersError(ErrorType.INVALID_INPUT, `Input is not valid JSON: ${err.message}`);
  }
  const result = await ask(input);
  printJson(result);
  return result.status === 'ok' ? 0 : 1;
}
