# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What it is

Beaconyard ingests telemetry from field devices over MQTT. Devices publish heartbeats with a device-local sequence number, and they buffer messages while offline and replay them on reconnect. The api reconciles those messages into current device state in Mongo, ignoring duplicates and stale messages, and pushes updates to a live Angular dashboard.

## Commands

Nx 23 + pnpm 11, single-package workspace: one npm script (`pnpm run eval`), no per-project `package.json`. Run Nx with `npx nx`. `pnpm nx` / `pnpm exec nx` print a pnpm dependency-check line to stdout first, which breaks `--json` output.

- Everything: `npx nx run-many -t lint test build`
- One project: `npx nx test contracts`, `npx nx lint web`, `npx nx build api`
- One test file: `npx nx test web --testPathPatterns=app.spec` (Jest 30, so the old `--testPathPattern` errors). By name: `-t "<name>"`.
- Typecheck: there is no typecheck target. Use `npx tsc -p apps/<app>/tsconfig.app.json --noEmit` or `npx tsc -p libs/<lib>/tsconfig.lib.json --noEmit`. `apps/web/tsconfig.spec.json` fails raw tsc with TS5107 (`moduleResolution: node10` is deprecated in TS 6) even though jest passes.
- Serve: `npx nx serve api` (builds, then runs `dist/apps/api/main.js`), `npx nx serve web` (Angular dev server on :4200)
- Local infra: `docker compose up -d` starts Mosquitto (1883 for the api, 1884 for evals, isolated by `mount_point eval/`, anonymous, dev only) and Mongo (27017).
- Evals: `pnpm run eval` runs every scenario in `evals/scenarios/`. `pnpm run eval -- <file>` runs one. Needs local infra. `npx nx run evals:acceptance` tests the harness itself.
- Dashboard: `DASHBOARD_ENABLED=true npx nx serve api` and `npx nx serve web`, then open http://localhost:4200. The web dev server proxies `/ws` to the api on port 3000.
- Config: every api setting is an env var read in `apps/api/src/config.ts`, with its default and validation. Invalid values fail startup.
- Full gate before handing back: `/verify`

## Architecture

- `apps/api`: Fastify service. Subscribes to MQTT, reconciles device state in Mongo, and serves the dashboard's WebSocket feed.
  - `src/mqtt/handlers/`: one file per topic, each with a matching test
  - `src/store/`: all Mongo reads and writes
  - `src/ws/`: WebSocket server for the dashboard
  - `src/alerts/`: alert rules, triggered by device state changes
- `apps/web`: Angular 22, zoneless (no zone.js), standalone components, new file naming (`app.ts` / `App`, not `app.component.ts`), selector prefix `app`, SCSS.
- `libs/contracts`: message and document types shared by api and web, imported as `@beaconyard/contracts`. The single definition of every message shape. No build target.
- The browser never connects to MQTT. The api subscribes to MQTT, reconciles state in Mongo, and pushes updates to the browser over its own WebSocket endpoint.
- `specs/` (requirements), `decisions/` (architecture records), `evals/` (scenario harness), `.claude/skills/` (repeatable procedures).

## Conventions

- Source uses ESM syntax (`import`/`export`). Build output format is owned by the Nx config (currently CJS for api). Do not change `module`, `moduleResolution`, or esbuild `format` settings without a decision record in `decisions/`.
- All projects compile with `strict: true`. `web` and `contracts` also use `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noImplicitOverride`; web also has Angular `strictTemplates`.
- Message identity is device ID plus device-local `seq` (see `decisions/001-message-id.md`). Event time comes from the message's `ts`, never from server clock.

## Workflow

1. The spec file named in the request is the ticket. It is the only source of requirements.
2. Plan first: a numbered list of files you will create or change and the tests you will add. Write no code until the plan is approved.
3. Implement only the approved plan. If you need to touch a file outside it, stop and explain why before doing it.
4. Done means every acceptance test in the spec exists, asserts the specified behavior, and passes, and `/verify` passes.
5. When blocked, stop and report what you tried. Do not work around a failure. Blocked includes: a test you cannot make pass within the plan, an ambiguous spec, or any decision listed under "Escalate".
6. Hand back a summary: files changed, tests added, and anything you were unsure about.
7. Never edit `specs/`, `decisions/`, `REVIEW-LOG.md`, or this file. If you think one is wrong, say so.

## Escalate, don't decide

Message ID format, ordering and conflict resolution, data retention, auth, module or output format, and any new dependency. Stop and ask.

## Review bar

Check your own work against this before handing back. The human reviews the diff against the same list.

- Every acceptance test in the spec exists and asserts the behavior, not just that code runs without throwing.
- No files changed outside the approved plan.
- No hardcoded values that belong in config (URLs, ports, thresholds, flags).
- No code path that silently returns less data than it should. Partial results fail loudly.
- Message handlers respect the ID scheme, are idempotent, and use the message's `ts`, not processing time.
- No new dependency without a stated reason.

## Never

- Never change the message ID format.
- Never write a handler that is not idempotent.
- Never write a document to Mongo whose type is not defined in `@beaconyard/contracts`.
- Never install a package without saying why.
- Never skip, delete, or weaken a test to make it pass (no `.skip`, `.only`, or loosened assertions).
- Never loosen compiler strictness or add `@ts-ignore`, `@ts-expect-error`, or `eslint-disable` without stating why.
- Never set `NX_IGNORE_*` environment variables, run `pnpm approve-builds`, or edit `allowBuilds`.

## Git

- Never stage, commit, push, or merge (`git add`, `git rm`, `git commit`, `git push`, `git merge` are denied in settings). The human stages and commits after reviewing the diff.
- Branches: `spec/NN-short-name`, one per spec, squash-merged to `main`.
- Commits: Conventional Commits scoped by spec. `feat(spec-NN): title` for spec work, `fix(spec-NN): title` for corrections found in review, `chore:` for tooling.
