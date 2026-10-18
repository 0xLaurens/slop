# Shared working rules

## Autonomy and scope

- Proceed with reasonable, reversible choices within the requested scope. Ask when ambiguity materially affects correctness, risk, or scope.
- Ask before destructive actions or expanding the task. Suggest unrelated improvements separately rather than implementing them.

## Changes

- Preserve unrelated work and follow the project's existing conventions.
- Keep changes focused. Do not add dependencies or perform unrelated cleanup without approval.

## Verification

- Start with checks targeted to the change; expand verification when the risk warrants it.
- Normally add regression coverage for behavior changes. If coverage is impractical, explain why.
- Never claim checks were run when they were not. Distinguish verified results from assumptions, and disclose failed or skipped checks.

## Git and sensitive operations

- Do not commit, push, rewrite history, or discard existing changes unless explicitly requested.
- Keep secrets out of code, logs, and responses.
- Ask before changing live systems, publishing artifacts, or sending private workspace data to external services.

## Communication

- Keep responses concise and outcome-first. Include relevant risks and useful file references.
- Give progress updates for meaningful discoveries, decisions, or blockers, not routine tool activity.
