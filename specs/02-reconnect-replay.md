# 02. Reconnect replay

## Why

Devices lose signal. While offline they keep recording heartbeats, and when they reconnect they send everything they buffered in one batch. Today nothing receives that batch, and nothing keeps history, so a device's offline period is invisible. After this spec, the api stores every unique heartbeat as an event, accepts replayed batches, and ends in the correct state no matter how messy the replay is. It also stops losing messages published while the api itself is down.

## Behavior

1. The api subscribes to `devices/+/replay` at QoS 1, in addition to `devices/+/heartbeat`, on every successful connect. Messages are routed to a handler by topic.
2. A replay payload is a JSON array of heartbeat objects, each with the same shape and rules as a live heartbeat.
3. Every valid heartbeat, live or replayed, is stored in `events`. An event whose device ID and `seq` already exist is ignored. It is not an error and does not create a reject.
4. If the same `seq` appears more than once in one batch, the first occurrence in the array is the one kept. If the first copy is invalid, the first valid copy is kept.
5. After a batch, device state is exactly what it would be if every valid entry had been sent as a live heartbeat: the highest `seq` wins, per `decisions/001-message-id.md`.
6. Live heartbeats keep their spec 01 behavior and now also write an event. A live heartbeat with a `seq` lower than current state is stored as an event and does not change state.
7. An invalid entry in a batch creates one reject and does not stop the rest of the batch. The reject's `payload` is that entry serialized as JSON, and its `reason` starts with `entry <index>:` (0-based), followed by the same field reason a live heartbeat would get.
8. A batch that is not valid JSON, is not an array, or has more than 1000 entries creates one reject for the whole batch, and nothing from it is stored. The reason starts with `batch:` and names what failed.
9. An empty array is valid and does nothing.
10. The api connects with a fixed client ID and a persistent session (`clean: false`), so the broker holds QoS 1 messages for it while it is down and delivers them when it reconnects.
11. Duplicate and stale messages never travel an error path, in the replay handler or the heartbeat handler.
12. Neither handler ever throws.
13. For each message, the event is written before device state, so state never shows a seq that history does not have.

## Data

Collection `events` (`EventRecord`): `deviceId`, `seq`, `ts`, `battery`, `status`. Unique index on `deviceId` plus `seq`. No server timestamps.

`EventRecord`, `ReplayBatch`, and `MAX_REPLAY_BATCH = 1000` live in `@beaconyard/contracts`.

`rejects` is an append-only log. It is not deduplicated: a batch with an invalid entry delivered twice creates two rejects.

New config: `MQTT_CLIENT_ID` (default `beaconyard-api`).

Devices publish heartbeats and replays at QoS 1.

## Acceptance tests

Tests call the handlers directly with a topic and a Buffer payload. Mongo comes from mongodb-memory-server. No broker.

Setup for tests 1 and 2: device `dev-1` has state at seq 5 from a live heartbeat, so one event exists. Then this batch of 20 entries arrives on `devices/dev-1/replay`, in this order:
`6, 7, 8, 10, 9, 11, 12, 13, 15, 14, 16, 17, 18, 19, 20, 21, 2, 7, 12, 20`
Every entry is valid and has a distinct `battery` value. Seqs 7, 12, and 20 appear twice (duplicates). 10 before 9 and 15 before 14 are out of order. Seq 2 is older than the server state.

1. After the batch: exactly 18 events (seq 5, plus 17 unique seqs from the batch). State equals the seq 21 entry. An event for seq 2 exists. For seqs 7, 12, and 20, the event holds the first occurrence's values. Zero rejects.
2. The same batch delivered a second time: still 18 events, the state document is unchanged, zero rejects.
3. A batch of 5 where entry 3 has `battery: 150`: 4 events, 1 reject whose reason starts with `entry 3:` and names `battery`, and whose payload is that entry as JSON.
4. Invalid JSON, a JSON object instead of an array, and a batch of 1001 entries: each creates exactly 1 reject naming what failed, and no events or state.
5. An empty array: no events, no state, no rejects.
6. A live heartbeat now writes one event. The same live heartbeat twice still makes one event.
7. A live heartbeat with seq 3 after state is at seq 5: an event for seq 3 exists, and state stays at seq 5.
8. A replay batch and live heartbeats for the same device handled concurrently with `Promise.all`, across many rounds: final state is the highest seq, and the event count equals the number of unique seqs. Any seq sent through both paths has identical contents in both, so the result does not depend on which arrives first.
9. A bad replay topic such as `devices//replay`: 1 reject naming `deviceId`.
10. Client, with a fake client: every connect subscribes to both topics, each message reaches the handler for its topic, and the connect options include the configured client ID and `clean: false`.
11. A batch where the highest seq appears twice with different values: the state and the event for that seq both hold the first occurrence's values.

## Out of scope

- Broker-side persistence across a broker restart (Mosquitto `persistence`)
- Acknowledging a message only after its write succeeds (the other half of the spec 01 gap, still open)
- Transactions between `events` and `devices`. Mongo here is standalone. The event is written first, so a failed state write leaves history ahead of state, never behind; the next heartbeat with a higher seq moves state forward. A failed event write is logged at error level and that event is lost, because the api acknowledges each message before writing it (see the gap above). Both writes are idempotent, so once that gap is closed a redelivery repairs a partial write.
- Detecting two copies of the same seq with different contents. The first copy is kept and later copies are ignored, even if they differ. A differing copy usually means a device bug or a seq reset (see decision 001).
- Event retention (decision 003, later)
- Running more than one api instance
- The dashboard and alerts
- Mosquitto's per-client queue limit (`max_queued_messages`, default 1000). While the api is down, messages beyond it are dropped by the broker.

## Decisions the agent may NOT make

- The batch cap, the first-occurrence rule, the reject reason format, and the event schema are as written here.
- Message identity and ordering stay as in `decisions/001-message-id.md`.
- No new dependencies.
- If routing by topic needs changes to `client.ts` beyond the plan, say so in the plan.
