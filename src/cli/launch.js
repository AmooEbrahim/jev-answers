import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, NPX_SPEC } from '../constants.js';

const binPath = fileURLToPath(new URL('../../bin/jev-answers.js', import.meta.url));

/** The command an MCP client should run to start the server. */
export function launchCommand(here = binPath) {
  const underNpx = here.split(path.sep).includes('_npx') || here.includes('/_npx/');
  return underNpx
    ? { command: 'npx', args: ['-y', NPX_SPEC, 'serve'] }
    : { command: process.execPath, args: [here, 'serve'] };
}

/** Is an executable with this name on PATH? */
export function onPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        accessSync(path.join(dir, name + ext), constants.X_OK);
        return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
}

export const CLIENTS = {
  claude: (cmd) => ['claude', ['mcp', 'add', '--scope', 'user', NAME, '--', cmd.command, ...cmd.args]],
  codex: (cmd) => ['codex', ['mcp', 'add', NAME, '--', cmd.command, ...cmd.args]],
  opencode: (cmd) => ['opencode', ['mcp', 'add', '--global', NAME, '--', cmd.command, ...cmd.args]],
};

export function snippets(cmd) {
  const tomlList = cmd.args.map((a) => JSON.stringify(a)).join(', ');
  return `OpenCode (~/.config/opencode/opencode.json):
${JSON.stringify({ mcp: { [NAME]: { type: 'local', command: [cmd.command, ...cmd.args], enabled: true } } }, null, 2)}

Codex (~/.codex/config.toml):
[mcp_servers.${NAME}]
command = ${JSON.stringify(cmd.command)}
args = [${tomlList}]

Cursor, Claude Desktop, and other clients that use "mcpServers":
${JSON.stringify({ mcpServers: { [NAME]: { command: cmd.command, args: cmd.args } } }, null, 2)}
`;
}
