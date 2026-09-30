import { loadConfig, redact } from '../config.js';
import { out, printJson } from './output.js';

export async function run() {
  const { values, file } = loadConfig();
  out(`Config file: ${file}`);
  printJson(redact(values));
  return 0;
}
