---
name: add-topic-handler
description: Use when adding a handler for a new MQTT topic in apps/api. Covers file locations, the handler and store pattern, wiring into the MQTT client, and the tests every handler must ship with.
---

# Add an MQTT topic handler

Follow the pattern of `apps/api/src/mqtt/handlers/heartbeat.ts`. Read it before planning.

## Files

1. `libs/contracts/src/lib/<name>.ts`: the message type and a hand-written `parse<Name>(raw: string): ParseResult<T>`. Build the result from known fields only, so extra fields are dropped. Export it from `libs/contracts/src/index.ts`.
2. `libs/contracts/src/lib/<name>.spec.ts`: table-driven unit tests for the parser.
3. `apps/api/src/store/<collection>.ts`: every Mongo read and write for this message. Handlers never call Mongo directly.
4. `apps/api/src/mqtt/handlers/<name>.ts`: exports `<NAME>_TOPIC` and `create<Name>Handler(deps)`, which returns `(topic, payload) => Promise<void>`.
5. `apps/api/src/mqtt/handlers/<name>.spec.ts`: the handler tests below.
6. `apps/api/src/mqtt/client.ts`: subscribe to the new topic and route its messages to the new handler.

## Handler rules

- The device ID comes from the topic, never the payload. Match the full topic with an anchored regex; a mismatch is a reject whose reason names `deviceId`.
- Validation failures write one reject (topic, raw payload, reason) and log a warning.
- The handler never throws. Wrap the body in try/catch and log at error level.
- Writes are idempotent and use a single Mongo operation. No read-then-write in code. Duplicates and stale messages must not travel an error path.
- Ordering follows `decisions/001-message-id.md`: `seq` decides, `ts` is stored, never compared.

## Client wiring

- Subscribe inside the `connect` handler so every connection subscribes itself. Never rely on the library to resubscribe.
- If `client.ts` still routes every message to one handler, the plan must include changing it to a map from topic to handler. Say so in the plan; don't do it silently.
- A failed subscribe logs at error level; a lower granted QoS logs a warning.

## Tests every handler ships with

Use mongodb-memory-server and call the handler directly with a topic and a Buffer payload. No broker.

- Valid message stores exactly the expected fields, with the device ID from the topic.
- Duplicate: the same message twice changes nothing and creates no reject.
- Out of order: a lower `seq` after a higher one leaves state unchanged.
- Concurrent: messages handled with `Promise.all` across many rounds end in the correct state.
- Malformed JSON, each invalid field, and a bad topic each create one reject with a reason naming what failed.
- An unknown extra field is accepted and not stored.
- A failing store does not make the handler throw.

## Before handing back

- Run `/verify`.
- In the summary, name the test that would fail if the ordering or idempotency rule were loosened.
- List the manual smoke test commands (`mosquitto_pub` and a `mongosh` query) for the human to run. Unit tests do not prove the broker path.
