# 01. Heartbeat ingest

## Why

Devices publish heartbeats, but nothing listens. Nobody can see a device's latest battery, status, or when it last checked in. After this spec, the api keeps one current-state record per device in Mongo, correct even when messages arrive twice or out of order.

## Behavior

1. On startup, the api connects to the MQTT broker and subscribes to `devices/+/heartbeat` at QoS 1.
2. The device ID is the middle segment of the topic. The payload never supplies it.
3. When a valid heartbeat arrives for a device with no state, the api creates that device's state from the message.
4. When a valid heartbeat arrives with a `seq` higher than the stored `seq`, the api replaces the device's state with the message's values.
5. When a valid heartbeat arrives with a `seq` equal to or lower than the stored `seq`, the api leaves state unchanged. This is not an error and does not create a reject.
6. The seq comparison and the write happen in a single Mongo operation, so two heartbeats handled at the same time cannot leave state at the lower `seq`.
7. When a message fails validation, the api writes one document to `rejects` with the topic, the raw payload as a string, and a reason naming the failed rule, logs a warning, and continues. It never throws out of the handler.
8. Unknown extra fields in a valid heartbeat are ignored. They do not cause a reject and are not stored.

## Data

Heartbeat payload:

- `seq`: integer, 1 or greater
- `ts`: ISO 8601 timestamp string, the device's event time
- `battery`: integer, 0 to 100
- `status`: one of `ok`, `warning`, `fault`

Collection `devices`, one document per device (`DeviceState`): `deviceId` (unique), `seq`, `ts`, `battery`, `status`.
Collection `rejects` (`RejectedMessage`): `topic`, `payload` (raw string), `reason`, `receivedAt` (server time; used for debugging only, never for ordering).

`Heartbeat`, `DeviceStatus`, `DeviceState`, `RejectedMessage`, and a `parseHeartbeat` validator live in `@beaconyard/contracts`.

Config from environment variables with local defaults: `MQTT_URL` (`mqtt://localhost:1883`), `MONGO_URL` (`mongodb://localhost:27017`), `MONGO_DB` (`beaconyard`).

## Acceptance tests

Tests call the heartbeat handler directly with a topic and payload. No broker is needed. Mongo comes from mongodb-memory-server.

1. A valid heartbeat for a new device creates exactly one `devices` document with all four fields and the device ID from the topic.
2. seq 5 then seq 4: state keeps seq 5's battery, status, and ts.
3. seq 4 then seq 5: state moves to seq 5.
4. seq 5 twice: one `devices` document, unchanged by the second, and zero rejects.
5. seq 5 and seq 6 handled concurrently: state ends at seq 6.
6. Malformed JSON: one reject with a reason, no `devices` document, handler does not throw.
7. `battery: 150`: rejected, and the reason names `battery`.
8. `status: "sleeping"`: rejected, and the reason names `status`.
9. An extra field `firmware: "1.2"`: accepted, and `firmware` is not stored.
10. Heartbeats from two devices produce two independent documents.

## Out of scope

- Event history (spec 02)
- Fastify, HTTP routes, WebSockets (spec 04)
- The dashboard, alerts
- Retention or size limits for `rejects`
- Broker-level integration tests

## Decisions the agent may NOT make

- Message identity and ordering are fixed by `decisions/001-message-id.md`.
- No new dependencies. `mongodb-memory-server` is already installed. Validation is hand-written in `parseHeartbeat`, not a library.
- Collection names, field names, and env var names are as written here.

## Clarifications (from plan review)

- `ts` is stored as the validated string, unchanged.
- `ts` must be RFC 3339: `YYYY-MM-DDTHH:mm:ss`, optional fraction, then `Z` or `±HH:MM`, and it must be a real date.
- A payload that breaks several rules gets one reject naming the first failure, checked in the order seq, ts, battery, status.
- A topic that is not exactly `devices/<non-empty id>/heartbeat` is rejected with a reason naming `deviceId`.
- A Mongo error while handling a valid message is logged at error level and does not create a reject.
- `seq` must satisfy `Number.isSafeInteger`.
- Known gap, out of scope: mqtt.js acknowledges a QoS 1 message before the write finishes, and the api uses a clean session, so a message can be lost if the write fails or the api is down. Revisit in spec 02.
- The api subscribes to `devices/+/heartbeat` on every successful connect, not once at startup. It never relies on the client library to resubscribe. A failed subscribe is logged at error level.
- If the broker grants a lower QoS than requested, the api logs a warning with the granted QoS.
