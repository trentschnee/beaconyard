# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Nx 23 + pnpm 11, single-package workspace: no npm scripts, no per-project `package.json`. Run Nx with `npx nx`. `pnpm nx` / `pnpm exec nx` print a pnpm dependency-check line to stdout first, which breaks `--json` output.

- Everything: `npx nx run-many -t lint test build`
- One project: `npx nx test contracts`, `npx nx lint web`, `npx nx build api`
- One test file: `npx nx test web --testPathPatterns=app.spec` (Jest 30, so the old `--testPathPattern` errors). By name: `-t "<name>"`.
- Typecheck: there is no typecheck target. Use `npx tsc -p apps/<app>/tsconfig.app.json --noEmit` or `npx tsc -p libs/<lib>/tsconfig.lib.json --noEmit`. `apps/web/tsconfig.spec.json` fails raw tsc with TS5107 (`moduleResolution: node10` is deprecated in TS 6) even though jest passes.
- Serve: `npx nx serve api` (builds, then runs `dist/apps/api/main.js`), `npx nx serve web` (Angular dev server on :4200)
- Local infra: `docker compose up -d` starts Mosquitto (1883 TCP, 9001 WebSockets, anonymous, dev only) and Mongo (27017).
- `nx affected` and `nx format:*` need a git base and won't work until there's a first commit. Format with `npx prettier --write <files>`.

## Architecture

- `apps/api`: Fastify service that owns Mongo persistence. Still a placeholder; `mongodb` and `mqtt` are installed at the root, `fastify` isn't yet.
- `apps/web`: Angular 22, zoneless (no zone.js), standalone components, new file naming (`app.ts` / `App`, not `app.component.ts`), selector prefix `app`, SCSS.
- `libs/contracts`: shared types, consumed from source through the `@beaconyard/contracts` path alias in `tsconfig.base.json`. No build target.
- The browser talks to the MQTT broker directly with mqtt.js over WebSockets (:9001), not through the api.

## Conventions

- Source uses ESM syntax (`import`/`export`). Build output format is owned by the Nx config (currently CJS for api). Do not change `module`, `moduleResolution`, or esbuild `format` settings without a decision record in `decisions/`.
- `api` is not strict (inherits `strict: false` from `tsconfig.base.json`). `web` and `contracts` are strict plus `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noImplicitOverride`; web also has Angular `strictTemplates`.
- `apps/web/src/app/app.spec.ts` asserts on the NxWelcome `h1`. Removing `nx-welcome.ts` means updating that test.

## Git

- Never commit, push, or merge. The human commits after reviewing the diff.
- Branches: `spec/NN-short-name`, one per spec, squash-merged to `main`.
- Commits: Conventional Commits scoped by spec. `feat(spec-NN): title` for spec work, `fix(spec-NN): title` for corrections found in review, `chore:` for tooling.
