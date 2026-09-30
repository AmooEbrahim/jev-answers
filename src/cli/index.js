import { NAME, VERSION } from '../constants.js';
import { JevAnswersError } from '../errors.js';
import { serve } from '../mcp/server.js';
import { HELP } from './help.js';
import { err, out } from './output.js';

const COMMANDS = {
  setup: () => import('./setup.js'),
  ask: () => import('./ask.js'),
  resend: () => import('./resend.js'),
  list: () => import('./list.js'),
  show: () => import('./show.js'),
  prune: () => import('./prune.js'),
  skill: () => import('./skill.js'),
  doctor: () => import('./doctor.js'),
  config: () => import('./config.js'),
};

/** @returns {Promise<number>} process exit code */
export async function main(argv) {
  const [command, ...rest] = argv;

  if (command === '--help' || command === '-h' || command === 'help') return out(HELP), 0;
  if (command === '--version' || command === '-v') return out(VERSION), 0;
  if (command === 'serve' || command === 'mcp' || (command === undefined && !process.stdin.isTTY)) {
    await serve();
    return 0;
  }
  if (command === undefined) return out(HELP), 0;
  if (!COMMANDS[command]) {
    err(`${NAME}: unknown command "${command}"\n`);
    err(HELP);
    return 2;
  }

  try {
    return await (await COMMANDS[command]()).run(rest);
  } catch (e) {
    if (!(e instanceof JevAnswersError)) throw e;
    err(`${NAME}: ${e.message}`);
    return e.type === 'invalid_input' ? 2 : 1;
  }
}
