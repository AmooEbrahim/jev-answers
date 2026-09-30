import { NAME, VERSION } from '../constants.js';

export const HELP = `${NAME} ${VERSION}
Send files and typed questions to TypeSafe's Jev decision model (MCP server + CLI).

Usage:
  jev-answers serve                 Start the MCP server on stdio (also: "mcp", or no args when piped)
  jev-answers setup [options]       Interactive setup: API key, model, client registration
  jev-answers ask [file|-]          Run a tool-input JSON file (or stdin) and print the result
  jev-answers resend <session>      Send an earlier session's request again in a new session
  jev-answers list [--limit N]      List recent sessions (default 20)
  jev-answers show <session> [--path]  Print a session's response (or error), or its folder path
  jev-answers prune --older-than <N>d [--yes]  Delete sessions older than N days
  jev-answers doctor [--live]       Show effective config, check the session folder, optionally test the API
  jev-answers config                Print the config file path and effective config

<session> is a session id, a unique part of one, a folder path, or "latest".

setup options (non-interactive):
  --provider typesafe|openrouter  --api-key KEY  [--model M] [--home DIR] [--base-url URL]
  --yes                           write the config without prompting
  --register claude,codex,opencode  also register the server with these clients

Other: --help, --version
`;
