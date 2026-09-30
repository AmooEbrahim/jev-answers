# Changelog

## 0.1.0

- Initial release.
- Hardening: API keys are validated, never echoed, and redacted from every recorded or returned error; `base_url` must be https (loopback excepted); redirects are not followed; Retry-After is capped at 60 s; provider error bodies are truncated at 8 KB; session files are mode 0600.
- Built-in glob matcher (`**`, `*`, `?`, `[...]`, `{a,b}`) and directory walker: symlinks are never followed, hidden files and directories are skipped unless the pattern names them, unreadable directories are skipped, walks are depth- and size-bounded, secret checks cover link targets.
- Token estimate counts non-ASCII text at one token per character.
- MCP server (stdio) with a single tool, `jev_ask`.
- Three-stage pipeline (collect, build, send), each stage reading only what the previous one wrote to the session folder.
- Providers: TypeSafe (`/v1/systemone`) and OpenRouter (decisions endpoint).
- CLI: `setup`, `ask`, `resend`, `list`, `show`, `prune`, `doctor`, `config`.
