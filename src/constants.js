import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const NAME = 'jev-answers';
export const VERSION = pkg.version;
export const NPX_SPEC = 'jev-answers';
export const TOOL_NAME = 'jev_ask';

export const DEFAULTS = {
  provider: 'typesafe',
  home: '~/.jev-answers',
  max_input_tokens: 28000,
  max_total_tokens: 56000,
  timeout_ms: 60000,
  max_retries: 2,
  max_file_bytes: 1048576,
  max_files: 200,
  allow_secret_files: false,
  retention_days: 0,
  debug: false,
};

export const STAGES = ['collect', 'build', 'send'];
