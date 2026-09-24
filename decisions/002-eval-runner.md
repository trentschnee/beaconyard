# 002. Eval runner runs as native TypeScript on Node

Status: Accepted
Date: 2026-09-24

The eval runner in `evals/` is written as `.mts` files and run directly by Node 22's built-in type stripping (`node evals/src/run.mts`). Its unit tests use `node:test`. The api and libraries keep their existing CJS build and Jest.

This avoids a new dependency such as tsx and an extra build step for a tool that is never shipped. The cost is a second module format and a second test runner in the repo, limited to `evals/`. Node only strips types without checking them, so `evals/tsconfig.json` is typechecked separately in /verify. If the evals ever need runtime code from the api or contracts, revisit this, because those imports would not resolve under native ESM.
