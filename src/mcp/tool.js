import { TOOL_NAME } from '../constants.js';

const DESCRIPTION = `Ask TypeSafe's Jev decision model typed questions about files and context, and get its raw judgment back.

What it does: reads the listed files, copies them into a new session folder, builds ONE request (state = files + context; every question is answered in a single pass), sends it to Jev, and returns the raw response plus the session folder path. It does not interpret the answers: no thresholds, no verdicts.

What Jev returns: typed judgments, not prose.
- noul: probability (0..1) that the answer is YES. 0.5 means it cannot tell; it does not mean "partly".
- choice: one option from your criteria, plus a probability per option.
- score: a position on your ordered levels (0 = first level), plus probabilities.

Input: "questions" is required, plus at least one of "files" or "context". Optional: "base_dir" (relative paths resolve against it), "label" (short name for the session folder), "model" (override the configured model). Unknown fields are rejected.
- files: paths, directories, globs, or {"path", "label"}. Expansion skips hidden (dot) files and folders unless the pattern names them (e.g. ".github/**/*.yml"), plus binaries, secret files, symlinks and folders like .git and node_modules; a file you name explicitly errors instead of being skipped.
- questions, keyed by id (letters, digits, _ . -):
  {"type": "noul", "instructions": "..."} (optional "criteria": {"true": "...", "false": "..."})
  {"type": "choice", "instructions": "...", "criteria": {"option": "meaning", ...}} (2+ options)
  {"type": "score", "instructions": "...", "criteria": ["lowest level", ..., "highest level"]} (2+ levels)

Git: this tool does not run git. Write the diff to a file first, then pass the path with a label. Include untracked files without touching the index:
{ git diff main...HEAD; git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index /dev/null {}; } > /tmp/jev/change.diff

Writing good questions:
- One specific, checkable fact per question. Prefer "Does any changed line log a card number?" over "Is there a security issue?". Generic "is there a bug?" questions are unreliable.
- Ask about written rules and requirements, and put those rules in "context".
- No arithmetic, counting or date math: work it out yourself, then ask about the result.
- Keep the state small: only relevant files. Irrelevant context lowers accuracy.
- Many questions per call is fine and cheap.

Size limit: estimated input (state + longest question) must fit the configured budget, about 28k tokens by default; otherwise the call fails before sending with context_too_large and lists the largest files.

Result: {"session", "status": "ok", "response": <raw Jev response>} or {"session", "status": "error", "error": {stage, type, message, details}}.

Example:
{"files": [{"path": "/tmp/jev/change.diff", "label": "git diff under review"}], "context": "Rule: card numbers must never be logged.", "questions": {"card_logged": {"type": "noul", "instructions": "Does any changed line write a card number or CVV to a log?"}}, "label": "payment-review"}`;

export const tool = {
  name: TOOL_NAME,
  title: 'Ask Jev',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Files to include: a path, directory, glob, or {path, label}.',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: { path: { type: 'string' }, label: { type: 'string' } },
              required: ['path'],
            },
          ],
        },
      },
      base_dir: { type: 'string', description: 'Directory that relative paths resolve against. Defaults to the server working directory.' },
      context: { type: 'string', description: 'Free text added to the state: the task, requirements, rules, notes.' },
      questions: {
        type: 'object',
        description: 'Questions keyed by id. Each has type (noul | choice | score), instructions, and criteria for choice and score.',
        additionalProperties: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['noul', 'choice', 'score'] },
            instructions: { type: 'string' },
            criteria: {
              description: 'choice: {option: description}. score: [level descriptions], lowest first. noul: optional {"true": "...", "false": "..."}.',
              anyOf: [
                { type: 'object', additionalProperties: { type: 'string' } },
                { type: 'array', items: { type: 'string' } },
              ],
            },
          },
          required: ['type', 'instructions'],
        },
      },
      label: { type: 'string', description: 'Short human name; used in the session folder name.' },
      model: { type: 'string', description: 'Override the configured Jev model for this call.' },
    },
    required: ['questions'],
  },
  annotations: {
    title: 'Ask Jev',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};
