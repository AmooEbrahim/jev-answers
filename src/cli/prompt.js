import readline from 'node:readline';
import { Writable } from 'node:stream';
import { ErrorType, JevAnswersError } from '../errors.js';
import { out } from './output.js';

const aborted = () => new JevAnswersError(ErrorType.CANCELLED, 'Cancelled.');

/**
 * One prompter per command. On a TTY it can hide typed input (for the API key) and Ctrl-D cancels.
 * With piped stdin, all input is read up front and running out of lines yields empty answers
 * (defaults / "no"), so nothing ever hangs waiting on a closed stream.
 */
export async function createPrompter() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    return {
      async ask(question) {
        process.stdout.write(question + '\n');
        return (lines.shift() ?? '').trim();
      },
      close() {},
    };
  }
  let muted = false;
  const output = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const closed = new Promise((_, reject) => rl.once('close', () => reject(aborted())));
  closed.catch(() => {}); // only matters while a question is pending
  return {
    async ask(question, { secret = false } = {}) {
      const pending = rl.question(question);
      muted = secret;
      try {
        return (await Promise.race([pending, closed])).trim();
      } finally {
        if (secret) { muted = false; out(); }
      }
    },
    close: () => rl.close(),
  };
}
