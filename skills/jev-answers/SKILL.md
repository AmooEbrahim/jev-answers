---
name: jev-answers
description: Fast, cheap typed checks with TypeSafe's Jev through the jev_ask MCP tool - yes/no probabilities, multiple choice and graded scores about specific files, diffs and written rules. Use when the user asks to check, verify or gate code, a diff or requirements with Jev; before finishing a change that has written rules or requirements to check against; or to classify, triage or grade text. Not for open-ended review, explanations or finding bugs without a concrete rule.
metadata:
  source: jev-answers
  version: "__VERSION__"
---

# Checking work with Jev (`jev_ask`)

`jev_ask` (MCP server `jev-answers`) reads the files you list, sends them plus all your questions to Jev in one request, and returns Jev's raw typed answers and the path of a session folder that keeps the inputs, the exact request and the response.

Jev is a fast classifier, not a reasoner. It is good at narrow, checkable questions about text that is in front of it. It is poor at open-ended "find the bugs", arithmetic, counting and multi-step reasoning. You stay responsible for the reasoning and for what to do with the answers.

If the tool is not available, tell the user to run `npx -y jev-answers@latest setup` and restart the client.

## Workflow: check a change

1. **Collect the rules.** Find the written rules and requirements that apply: the user's request, the task or issue text, CLAUDE.md / AGENTS.md, CONTRIBUTING, security or style policies. Put the relevant ones, short and verbatim, in `context`.
2. **Write the diff to a file.** The tool never runs git. Include untracked files, which plain `git diff` omits:
   ```sh
   mkdir -p /tmp/jev
   { git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index /dev/null {}; } > /tmp/jev/change.diff
   ```
   For a whole branch use `git diff main...HEAD` instead of `git diff HEAD`.
3. **Pick the files.** The diff, plus only what is needed to judge it (for example the full file around a tricky hunk). Less is better: irrelevant context lowers accuracy. The budget is about 28k tokens.
4. **Write the questions** (next section). One call can hold many questions; the files are sent once.
5. **Call `jev_ask`** with a short `label`, for example `"label": "auth-change-rules"`.
6. **Act on the answers.** Verify anything flagged by reading the code yourself, fix it, then run the same call again to confirm.

## Writing good questions

- One checkable fact per question, answerable from the text you pass. Name the rule or requirement explicitly.
- Good:
  - "Does any changed line write a password, token or card number to a log?"
  - "Does the new endpoint check that the current user owns the order before returning it?"
  - "Does every new public function in the diff have a test in the diff?"
  - "Does the change remove or rename an exported function or a public API route?"
  - "Does the diff implement requirement R2 from `context`?"
- Bad:
  - "Is there a bug?" / "Is this code good?" (too open; unreliable)
  - "How many functions changed?" (counting)
  - "Is the timeout under 30 seconds?" when the value must be computed (do the math yourself, then ask about the rule)
- Use `noul` for rules, `choice` for classification (include a `none` or `other` option), `score` for graded judgments with clearly described levels.

## Question shapes

```json
{
  "files": [{"path": "/tmp/jev/change.diff", "label": "git diff of the change under review"}],
  "context": "Rules: (1) Never log secrets or card numbers. (2) Every endpoint checks resource ownership.",
  "label": "payment-rules",
  "questions": {
    "logs_secret": {"type": "noul", "instructions": "Does any changed line write a secret or card number to a log?"},
    "change_kind": {"type": "choice", "instructions": "What kind of change is this?",
      "criteria": {"feature": "adds new behaviour", "fix": "corrects existing behaviour", "refactor": "no behaviour change", "other": "none of these"}},
    "risk": {"type": "score", "instructions": "How risky is deploying this change?",
      "criteria": ["No risk: docs or tests only", "Low: small, isolated change", "Medium: touches shared code", "High: auth, payments or data migrations"]}
  }
}
```

At least one of `files` or `context` is required. Paths should be absolute. Globs and directories work but skip hidden, binary and secret files.

## Reading the answers

- `noul` is the probability that the answer is YES. Near 0 or 1 is confident. Roughly 0.35 to 0.65 means Jev cannot tell: check it yourself or add the missing context and ask again. It never means "partly true".
- `choice` gives the picked option plus `probabilities` for every option; `confidence` says how concentrated they are.
- `score` is a position from 0 to (levels - 1) and can fall between levels. It is not a percentage.
- These are calibrated probabilities, not proof. Report them with their numbers and the session folder path, for example "Jev: 0.93 that a card number is logged (session: ...)". A low probability is not a guarantee, and a high one is a lead to verify, not a verdict.
- `status: "error"`: read `error.type`. `context_too_large` lists the largest files to drop; `invalid_question` / `invalid_input` means fix the call; `config_error` means the user needs to run `jev-answers setup`.

## Other uses

- **Classify or triage** a ticket, log excerpt or message: one call per item, a `choice` question with clear options, plus `noul` questions for flags such as "is this urgent?".
- **Grade** a draft against a rubric: one `score` question per rubric line, levels described concretely.
- **Gate** before an irreversible step: ask whether the planned action violates a written policy, and stop to ask the user when the answer is uncertain.
