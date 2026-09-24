---
name: verify
description: Run the full beaconyard check (lint, test, build, typecheck, prettier on changed files) and report pass/fail per step. Use before handing a diff back for review, or when asked to verify, check, or make sure the build works.
---

Run each step from the repo root, even if an earlier one fails, then report a short pass/fail table with the relevant error output for anything that failed. Don't fix anything unless asked.

1. Lint, test, build:

   ```bash
   npx nx run-many -t lint test build
   ```

   Use `npx nx`, not `pnpm nx`. Add `--skip-nx-cache` only if a cached result looks stale.

2. Typecheck. There's no Nx typecheck target, so run tsc directly:

   ```bash
   for f in apps/*/tsconfig.app.json libs/*/tsconfig.lib.json evals/tsconfig.json; do echo "== $f"; npx tsc -p "$f" --noEmit; done
   ```

   `evals/tsconfig.json` covers the eval runner and its tests. Node runs those `.mts` files by stripping types without checking them (decisions/002-eval-runner.md), so this is their only typecheck.

   Skip `apps/web/tsconfig.spec.json`. It fails with TS5107 (`moduleResolution: node10`) regardless of the code, and jest covers the specs.

3. Prettier on modified and untracked files:

   ```bash
   git ls-files -m -o --exclude-standard -z | xargs -0 npx prettier --check --ignore-unknown --no-error-on-unmatched-pattern
   ```

   Until the first commit every file counts as untracked, so the scaffold files that were never formatted show up here too (root `eslint.config.mjs`, `jest.config.ts`, `jest.preset.js`, `docker-compose.yml`, `README.md`, and most of `apps/web`). Report those separately from files touched in this session.

If `$ARGUMENTS` names projects (e.g. `/verify api contracts`), use `-p <projects>` instead of running everything in step 1, and limit step 2 to those projects' tsconfigs.
