## What changed

<!-- A short description of the change and the problem it solves. -->

## Why

<!-- The engineering reason. Link the issue if there is one. -->

## How it was verified

<!-- Exact commands and their results. Do not claim tests you did not run. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:e2e` (if the UI changed)
- [ ] Real review exercised on a repository (describe it)

## Screenshots

<!-- UI changes: before/after, captured from the running extension. Redact secrets. -->

## Checklist

- [ ] No finding, claim or UI element was added that implies unimplemented functionality.
- [ ] New behaviour has a test (unit, integration, UI or E2E as appropriate).
- [ ] Evidence contract preserved: findings cite file, line and repository text.
- [ ] `packages/core` still has no VS Code or AI dependency.
- [ ] Documentation updated (README, docs/, CHANGELOG).
- [ ] No secrets, generated reports or `.diffwise/` contents committed.
