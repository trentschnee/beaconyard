# 03. Eval harness

## Why

Every test so far was written by the agent that wrote the code. They are good tests, but they are the agent's idea of correct. The eval harness is an independent check: scenario files written by a human describe messages, faults included, and the expected end state. A runner plays each scenario through the real broker against a running api and reports pass or fail. Adding a scenario means adding a JSON file, not code.

## Behavior

1. `pnpm run eval` runs every scenario in `evals/scenarios/`, in file name order. `pnpm run eval -- <path>` runs one scenario file.
2. The runner requires the local infra from `docker compose up -d`. If the broker or Mongo is unreachable, it exits non-zero within 10 seconds with a message that names which one and says to run `docker compose up -d`.
3. The runner starts the built api as a separate process with `MONGO_DB=beaconyard_eval` and `MQTT_CLIENT_ID=beaconyard-eval`, and waits until it has connected to the broker. It never touches the `beaconyard` database. `pnpm run eval` builds the api first, so it never runs stale code.
4. Before starting the api, the runner clears any leftover broker session for `beaconyard-eval`, so messages from an earlier run cannot leak in.
5. For each scenario, the runner empties `devices`, `events`, and `rejects` in `beaconyard_eval` (keeping indexes), then publishes the scenario's messages to the real broker at QoS 1, one at a time in file order, waiting for the broker to acknowledge each one.
6. After publishing, the runner polls the eval database until it matches the scenario's expectations, then waits 500 ms and checks again, so a late extra write still fails the scenario. If it never matches within 5 seconds, the scenario fails.
7. Each scenario prints one line: `PASS <name>` or `FAIL <name>`. A failure also prints which part failed (`devices`, `events`, or `rejects`) with the expected and actual values.
8. The runner exits 0 only if every scenario passes. It stops the api process on exit, including on failure or Ctrl+C.
9. A scenario file that does not match the schema below fails with a message naming the file and the problem. It is never skipped.
10. The runner only observes. If a scenario exposes a bug in the api, the agent reports it and does not fix the api in this spec.

## Data

Scenario file schema:

```json
{
  "name": "duplicates",
  "description": "One sentence on what this scenario proves.",
  "messages": [
    { "topic": "devices/dup-1/heartbeat", "payload": { "seq": 1, "ts": "2026-09-24T10:01:00Z", "battery": 90, "status": "ok" } },
    { "topic": "devices/dup-1/replay", "payload": [] },
    { "topic": "devices/dup-1/heartbeat", "raw": "not json" }
  ],
  "expect": {
    "devices": [{ "deviceId": "dup-1", "seq": 1, "ts": "2026-09-24T10:01:00Z", "battery": 90, "status": "ok" }],
    "events": [{ "deviceId": "dup-1", "seq": 1, "ts": "2026-09-24T10:01:00Z", "battery": 90, "status": "ok" }],
    "rejects": [{ "topic": "devices/dup-1/heartbeat", "reasonStartsWith": "payload is not valid JSON" }]
  }
}
```

- Each message has exactly one of `payload` (sent as JSON) or `raw` (sent as is).
- `devices` and `events` must match exactly, in any order. `rejects` match on topic and reason prefix; `payload` and `receivedAt` are not compared.
- Device IDs are unique to each scenario.
- Duplicate copies of a seq are always identical. Through the broker, handlers run concurrently, so differing copies would make the result depend on timing (see spec 02 Out of scope).

Scenarios in `evals/scenarios/`:

- `clean.json`: device `clean-1` sends heartbeats seq 1, 2, 3 in order. 3 events, status at seq 3, no rejects.
- `duplicates.json`: device `dup-1` sends heartbeat seq 1, seq 2, seq 2 again, then a replay batch of seqs 1, 2, 3, then the same malformed payload twice. 3 events, status at seq 3, 2 rejects (rejects are append-only).
- `out-of-order.json`: device `ooo-1` sends heartbeats seq 3, 1, 2, then a replay batch of seqs 5, 4. 5 events, status at seq 5, no rejects.

`evals/self-test/` holds scenarios that must fail. They are used only by the acceptance tests.

## Acceptance tests

1. With infra up, `pnpm run eval` prints `PASS` for clean, duplicates, and out-of-order, and exits 0.
2. A self-test scenario expecting the wrong battery prints `FAIL`, names `devices`, shows expected and actual, and exits 1.
3. Self-test scenarios with a missing expected event and a missing expected reject each fail, naming `events` and `rejects` respectively.
4. A self-test scenario that expects no rejects, but sends a malformed message, fails.
5. Running `pnpm run eval` twice in a row gives the same result both times.
6. The `beaconyard` database has the same document counts before and after a run.
7. With the broker stopped, `pnpm run eval` exits non-zero within 10 seconds, and the message names the broker and `docker compose up -d`.
8. A scenario file missing `expect` fails with a message naming the file and `expect`.
9. Unit tests cover the scenario schema check and the comparison of devices, events, and rejects, with no broker or Mongo.

## Out of scope

- Stopping and restarting the api inside a scenario (mailbox scenarios)
- Running evals in CI
- Running scenarios in parallel
- Load or performance testing
- Duplicate copies of a seq with different contents

## Decisions the agent may NOT make

- The scenario schema, eval database name, eval client ID, and timeouts are as written here.
- The runner never writes to the `beaconyard` database.
- No new dependencies. If running the TypeScript runner seems to need one, stop and ask.
- Do not change api behavior in this spec. Report any bug a scenario finds.

## Clarifications (from plan review)

- The runner and the eval api connect to a separate Mosquitto listener on 127.0.0.1:1884 with `mount_point eval/`, so eval traffic never reaches the dev api's session on port 1883.
- After the api reports it connected, the runner publishes a probe heartbeat for device `eval-ready` and waits for its event before running scenarios.
- The runner runs as native ESM with Node's built-in type stripping, and its unit tests use node:test. See `decisions/002-eval-runner.md`.
