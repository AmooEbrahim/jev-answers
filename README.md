# jev-answers

[![npm](https://img.shields.io/npm/v/jev-answers)](https://www.npmjs.com/package/jev-answers)
[![CI](https://github.com/AmooEbrahim/jev-answers/actions/workflows/ci.yml/badge.svg)](https://github.com/AmooEbrahim/jev-answers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small MCP server and CLI that sends files and typed questions to TypeSafe's **Jev** decision model and returns the raw answer. Every request gets its own session folder that keeps the inputs, the exact request and the response.

- Zero dependencies, plain Node.js (>= 22), no build step.
- One MCP tool, `jev_ask`, for Claude Code, Codex, OpenCode, Cursor, Claude Desktop and any other MCP client.
- A thin pipe: it never interprets answers. No thresholds, no verdicts, no "flags". You get the provider's response body unchanged.
- It does not run git or any other command. If you want a diff reviewed, write the diff to a file and pass the path.

Jev answers typed questions with probabilities instead of prose:

| type | question | answer |
|---|---|---|
| `noul` | a yes/no question | probability that the answer is YES (0.5 means it cannot tell) |
| `choice` | pick one option | the chosen option plus a probability per option |
| `score` | position on ordered levels | a number between 0 and (levels - 1), plus probabilities |

This project is not affiliated with TypeSafe AI.

## How it works

Each call runs three independent stages. Each stage reads only what the previous one wrote into the session folder.

```
collect  ->  build  ->  send
```

```
~/.jev-answers/sessions/20260930-164512-payment-review-7f3a/
  input.json       the call arguments, exactly as received
  inputs/          collected copies of every file (relative layout kept; outside files under _external/)
  manifest.json    what was collected and what was skipped, with sizes and sha256
  request.json     the exact body that was sent (never contains the API key)
  response.json    the provider's raw response
  error.json       only on failure: {stage, type, message, details}
  meta.json        id, label, provider, model, status, token estimate, timings, HTTP status
```

`sessions/latest` is a symlink to the newest session.

## Install

Run the setup wizard. It asks for your provider, API key and model, writes the config file, and offers to register the server with the MCP clients it finds on your machine.

```sh
npx -y jev-answers setup

# or the latest main branch straight from GitHub
npx -y github:AmooEbrahim/jev-answers setup

# or from a clone
node bin/jev-answers.js setup
```

npx caches packages. To pick up a new release, run `npx -y jev-answers@latest --version` once.

Get a key at [console.typesafe.ai](https://console.typesafe.ai) (TypeSafe direct) or [openrouter.ai/keys](https://openrouter.ai/keys) (OpenRouter). The key is stored in the config file (mode 0600), so your client configs need no environment variables.

Switching provider drops the stored key, model and base URL, because they belong to the old provider; in `--yes` mode you must pass `--api-key` when you switch. Optional flags: `--model`, `--home`, `--base-url`.

Non-interactive:

```sh
jev-answers setup --provider typesafe --api-key "$KEY" --yes
jev-answers setup --provider typesafe --api-key "$KEY" --yes --register claude,codex,opencode
```

### Manual client configuration

Use whichever launch command fits: `npx -y jev-answers serve`, or `/absolute/path/to/node /absolute/path/to/bin/jev-answers.js serve` for a clone (setup writes the full path of the running Node). On Windows, setup prints the registration commands instead of running them.

Claude Code:

```sh
claude mcp add --scope user jev-answers -- npx -y jev-answers serve
```

Codex:

```sh
codex mcp add jev-answers -- npx -y jev-answers serve
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.jev-answers]
command = "npx"
args = ["-y", "jev-answers", "serve"]
```

OpenCode:

```sh
opencode mcp add --global jev-answers -- npx -y jev-answers serve
```

or in `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "jev-answers": {
      "type": "local",
      "command": ["npx", "-y", "jev-answers", "serve"],
      "enabled": true
    }
  }
}
```

Cursor, Claude Desktop and other clients that use `mcpServers`:

```json
{
  "mcpServers": {
    "jev-answers": {
      "command": "npx",
      "args": ["-y", "jev-answers", "serve"]
    }
  }
}
```

If you prefer environment variables over the config file, add `"env": {"JEV_ANSWERS_API_KEY": "..."}` to the client entry. Note that some clients do not expand `${VAR}` references; the server reports a clear `config_error` if it sees an unexpanded placeholder.

## Configuration

Precedence, low to high: built-in defaults, config file, environment variables, the per-call `model`.

The config file is `$JEV_ANSWERS_CONFIG` if set, otherwise `$XDG_CONFIG_HOME/jev-answers/config.json`, otherwise `~/.config/jev-answers/config.json`.

| key | environment variable | default |
|---|---|---|
| `provider` | `JEV_ANSWERS_PROVIDER` | `typesafe` (or `openrouter`) |
| `base_url` | `JEV_ANSWERS_BASE_URL` | per provider, see below |
| `model` | `JEV_ANSWERS_MODEL` | `jev-latest` (TypeSafe), `~typesafe/jev-latest` (OpenRouter) |
| `api_key` | `JEV_ANSWERS_API_KEY` | falls back to `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` for the chosen provider |
| `home` | `JEV_ANSWERS_HOME` | `~/.jev-answers` |
| `max_input_tokens` | `JEV_ANSWERS_MAX_INPUT_TOKENS` | `28000` |
| `max_total_tokens` | `JEV_ANSWERS_MAX_TOTAL_TOKENS` | `56000` |
| `timeout_ms` | `JEV_ANSWERS_TIMEOUT_MS` | `60000` (per attempt) |
| `max_retries` | `JEV_ANSWERS_MAX_RETRIES` | `2` |
| `max_file_bytes` | `JEV_ANSWERS_MAX_FILE_BYTES` | `1048576` |
| `max_files` | `JEV_ANSWERS_MAX_FILES` | `200` |
| `allow_secret_files` | `JEV_ANSWERS_ALLOW_SECRET_FILES` | `false` |
| `retention_days` | `JEV_ANSWERS_RETENTION_DAYS` | `0` (keep forever) |
| `debug` | `JEV_ANSWERS_DEBUG` | `false` (logs go to stderr) |

`base_url` is the full endpoint URL:

- TypeSafe: `https://api.typesafe.ai/v1/systemone`
- OpenRouter: `https://openrouter.ai/api/alpha/decisions` (an alpha endpoint that may move). `https://openrouter.ai/api/v1/systemone` is an alternative TypeSafe-compatible path you can set here.

Any gateway that speaks the same request format works too.

Check what is in effect with `jev-answers config` or `jev-answers doctor`.

## The `jev_ask` tool

### Input

```json
{
  "files": [
    "/abs/path/app/Services/PaymentService.php",
    {"path": "/tmp/review/change.diff", "label": "git diff of the change under review"},
    "app/Http/Controllers/**/*.php"
  ],
  "base_dir": "/abs/project/root",
  "context": "Optional free text: the task, requirements, rules, notes.",
  "questions": { "...": "see below" },
  "label": "payment-review",
  "model": "jev-latest"
}
```

- `files`: paths, directories, globs, or `{path, label}`. Relative paths resolve against `base_dir` (default: the server's working directory); absolute paths are safest.
- `context`: free text that is added to the state next to the files.
- At least one of `files` or `context` is required. `questions` is required.
- Directories and globs (`**`, `*`, `?`, `[...]`, `{a,b}`) are expanded by the tool itself. Following the usual glob convention, both skip hidden entries (names starting with `.`, and everything inside hidden directories) unless the pattern segment itself starts with a dot: `.github/**/*.yml` and `**/.eslintrc*` work, `**/*.yml` does not reach into `.github`. Hidden entries are listed in `manifest.json` (a hidden directory once, not its contents). A `*.md` pattern only looks as deep as the pattern is long, a trailing slash (`src/`, `src/**/`) means the directory itself, and an expansion that visits more than 20,000 entries fails with `invalid_input` so you can narrow it. Unreadable directories are skipped with reason `unreadable`. Expansion skips any path inside `.git`, `node_modules`, `vendor`, `dist`, `build`, `.next`, `.venv`, `venv`, `__pycache__`, `coverage` or `.jev-answers`, plus binary files, secret files and symlinks (files and directories; they are never followed). Skipped files are listed in `manifest.json` under `skipped` with a reason.
- A file you name explicitly is never skipped silently: if it is missing, binary, secret or too large, the call fails. An explicitly named symlink is allowed, but both the link and its target are checked against the secret-file patterns.
- If nothing was collected and there is no `context`, the call fails with `invalid_input` instead of sending an empty state.
- Unknown top-level fields (for example a `file` typo) are rejected with `invalid_input`.
- `label` becomes part of the session folder name. `model` overrides the configured model for this call.

### Questions

Question ids match `^[A-Za-z0-9_.-]{1,64}$`. Each question has a `type`, `instructions`, and (for choice and score) `criteria`. Unknown fields are rejected.

```json
{
  "card_logged": {
    "type": "noul",
    "instructions": "Does any changed line write a card number or CVV to a log?"
  },
  "layer": {
    "type": "choice",
    "instructions": "Which layer does this change mainly touch?",
    "criteria": {"frontend": "UI code", "backend": "server code", "database": "schema or queries"}
  },
  "risk": {
    "type": "score",
    "instructions": "How risky is deploying this change?",
    "criteria": ["No risk", "Low risk", "Moderate risk", "High risk"]
  }
}
```

- `noul`: `criteria` is optional; if given it must be `{"true": "...", "false": "..."}`.
- `choice`: `criteria` is an object of 2 to 255 options (name to description; a description may be `null`).
- `score`: `criteria` is an array of at least 2 level descriptions, lowest first.
- `instructions` is a string in the advertised tool schema. At runtime a JSON object or array is also accepted (Jev takes structured instructions) and sent as given.

Ready-to-use inputs are in [`examples/`](examples).

### Output

```json
{
  "session": "/home/u/.jev-answers/sessions/20260930-164512-payment-review-7f3a",
  "status": "ok",
  "response": {
    "model": "jev-1.13.0",
    "answers": {
      "card_logged": {"type": "noul", "noul": 0.03}
    },
    "usage": {"input_tokens": 476, "output_tokens": 12}
  }
}
```

`response` is the provider's body, unchanged. On failure:

```json
{
  "session": "...",
  "status": "error",
  "error": {"stage": "build", "type": "context_too_large", "message": "...", "details": {}}
}
```

`stage` is one of `config`, `session`, `collect`, `build`, `send`. `config` and `session` errors happen before a session folder exists or is usable, so `session` may be `null`.

Error types: `config_error`, `session_error`, `internal_error`, `invalid_input`, `invalid_question`, `file_not_found`, `file_unreadable`, `binary_file`, `secret_file`, `file_too_large`, `too_many_files`, `missing_artifact`, `context_too_large`, `auth_error`, `payment_required`, `invalid_request`, `rate_limited`, `overloaded`, `provider_error`, `timeout`, `network_error`, `invalid_response`, `cancelled`.

Provider error bodies are kept in `error.json` under `details.body`: JSON bodies up to 8 KB as they are, larger ones cut to the first 8 KB as text with `details.body_truncated: true`. The API key and any `Bearer ...` token are replaced with `[redacted]` in every recorded or returned error.

Over MCP, errors come back as a normal tool result with `isError: true`.

### Reviewing a diff

The tool does not run git. Write the diff to a file and pass it:

```sh
mkdir -p /tmp/jev
git diff main...HEAD > /tmp/jev/change.diff
```

`git diff` leaves out untracked files. Add them by diffing each one against `/dev/null`, which does not touch your index:

```sh
{
  git diff main...HEAD
  git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index /dev/null {}
} > /tmp/jev/change.diff
```

Then pass `{"path": "/tmp/jev/change.diff", "label": "git diff of the change under review"}` together with the files that give the diff its context.

### Writing good questions

- One specific, checkable fact per question. Prefer "Does any changed line log a card number?" over "Is there a security issue?". Generic "is there a bug?" questions are unreliable.
- Ask about written rules and requirements, and put those rules in `context`.
- No arithmetic, counting or date math. Work it out yourself first, then ask about the result.
- Keep the state small: pass only the relevant files. Irrelevant context lowers accuracy.
- Many questions per call is fine and cheap; they are all answered in one pass.

## CLI

```
jev-answers serve                 start the MCP server on stdio (also "mcp"; no args + piped stdin does the same)
jev-answers setup [options]       interactive setup (see Install for the non-interactive flags)
jev-answers ask [file|-]          run a tool-input JSON file or stdin, print the result; exit 0 ok / 1 error
jev-answers resend <session>      send an earlier session's request again, in a new session
jev-answers list [--limit N]      newest first (default 20)
jev-answers show <session> [--path]  print response.json (or error.json), or the folder path
jev-answers prune --older-than 30d [--yes]
jev-answers doctor [--live]       effective config with sources, folder check; --live sends one tiny question
jev-answers config                config file path and effective config (key masked)
```

`<session>` is an id, a unique part of an id, a folder path, or `latest`.

## Limits

- Jev accepts about 64k tokens per request in total and about 32k for the state plus the single longest question. This tool estimates tokens conservatively (ASCII characters / 3.5, plus one token for every non-ASCII character, since Persian, CJK and similar text tokenizes much worse) and, by default, stops at 28k and 56k so oversized requests fail locally with `context_too_large` (listing the five largest files) instead of being sent and billed.
- Per file: 1 MiB by default. Per call: 200 files by default.
- Retries: network errors, timeouts and HTTP 408, 429, 500, 502, 503, 504, 524 and 529 are retried with exponential backoff (1s, 2s, 4s, capped at 30s), honouring `Retry-After` as a minimum. If the server asks for more than 60 seconds, retrying stops and the call fails (`rate_limited` or `overloaded`, with `details.retry_after_seconds`). 400, 401, 402, 403, 404, 413 and 422 are never retried, and neither are redirects (they are not followed; set `base_url` to the final URL) or invalid URLs.
- Bounds: `timeout_ms` 1000 to 2147483647, `max_retries` 0 to 10; other numeric settings must be positive (`retention_days` may be 0).

## Privacy and security

- The contents of the files you pass, the `context` and the questions are sent to the configured provider (TypeSafe or OpenRouter). Nothing else is sent. The tool makes no other network calls.
- Secret-looking files are blocked: `.env` and `.env.*` (but not `.env.example`, `.sample`, `.template`, `.dist`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, SSH private keys (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`), `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.envrc`, `*.tfvars`, `terraform.tfstate` (and `.backup`), `*.ppk`, `.htpasswd`, `.docker/config.json`, `.aws/credentials`, and SSH private keys with any suffix (`id_rsa_work`, but not `*.pub`). Any `.env.*` ending in `.example`, `.sample`, `.template` or `.dist` is allowed. Glob and directory expansion skips secret files; naming one explicitly is an error. Set `allow_secret_files` to override. This is a name-based safety net, not a scanner: secrets inside ordinary files are not detected.
- The API key lives in the config file with mode 0600 (the directory is 0700) or in an environment variable. It is never written to a session folder and is masked in all output.
- Session folders are stored locally and contain full copies of what was sent, so they may hold sensitive code. They live under `~/.jev-answers` (mode 0700). Set `retention_days` to delete old sessions automatically, or run `jev-answers prune`.
- `base_url` must use https, because the key is sent in the `Authorization` header. Plain http is accepted only for loopback hosts (`localhost`, `127.0.0.0/8`, `::1`). Redirects are not followed, so the key cannot be forwarded to another host.
- Userinfo and query strings in `base_url` are masked in `meta.json` and in `config` / `doctor` output. Keys containing whitespace or non-ASCII characters are rejected without being echoed.
- Session files are written with mode 0600 (folders 0700).

## Teaching your agent when to use it

Paste this into `CLAUDE.md`, `AGENTS.md` or your client's equivalent:

```markdown
## Jev (jev_ask)

Use the `jev_ask` MCP tool when I ask for a check that has a definite yes/no, multiple-choice or graded answer about specific files or written rules (for example reviewing a diff against our rules before a commit).

- Write git diffs to a file first and pass the path with a label: `{ git diff main...HEAD; git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index /dev/null {}; } > /tmp/jev/change.diff` (this also includes untracked files and does not touch the index).
- Put the written rules and requirements in `context`. Pass only the relevant files.
- Ask narrow, checkable questions ("Does any changed line log a card number?"), not "is there a bug?". Do arithmetic and counting yourself.
- Jev returns probabilities. A `noul` value is the probability of YES; 0.5 means it cannot tell. Report the numbers and the session folder path; do not present them as certainties.
```

## Troubleshooting

- `jev-answers doctor` shows the effective config and where each value comes from. `doctor --live` sends one tiny question to verify the key and endpoint.
- `config_error: No API key configured`: run `jev-answers setup`, or set `JEV_ANSWERS_API_KEY`.
- `config_error` mentioning a placeholder: your client passed a literal `${...}` as the key. Put the key in the config file instead.
- `context_too_large`: the error lists the largest files. Drop or narrow them, or pass a smaller diff.
- `secret_file` or `binary_file` for a file you named: it is blocked on purpose. Copy the relevant part to a plain file, or set `allow_secret_files`.
- `auth_error` (401/403): wrong or revoked key. On OpenRouter use an inference key, not a management key.
- `invalid_input` "Nothing to send": every file you listed was skipped (secret, binary, symlink, ...) and there was no `context`. See `manifest.json` for the reasons.
- Server prints nothing in the client: run `JEV_ANSWERS_DEBUG=1 jev-answers serve` and watch stderr. stdout is reserved for JSON-RPC.
- Look inside the session folder (`jev-answers show latest --path`): `request.json` is exactly what was sent, and `error.json` has the provider's error body.

## Development

```sh
npm test        # node --test "test/**/*.test.js"; no network access needed
```

Tests use a local fake provider and temporary directories; they never touch `~/.jev-answers` or your real config. The code is plain ESM with no dependencies. Layout:

```
bin/jev-answers.js      CLI entry
src/stages/             collect, build, send (independent, each reads the session folder)
src/providers/          typesafe.js, openrouter.js
src/pipeline.js         ask() runs the three stages and never throws
src/mcp/                stdio JSON-RPC server and the tool definition
src/cli/                setup, ask, resend, list, show, prune, doctor, config
```

## License

MIT
