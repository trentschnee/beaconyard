# 04. Live dashboard

## Why

Device state lives in Mongo, but the only way to see it is a database query. An operator wants to glance at a page and see every device's battery, status, and when it last checked in, updating on its own as heartbeats arrive. The page ships behind a feature flag that is off by default, so the code can be deployed before anyone sees it.

## Behavior

1. The api always starts an HTTP server on `HTTP_HOST`:`HTTP_PORT`, whether or not the dashboard is enabled.
2. When `DASHBOARD_ENABLED` is not `true`, the api registers no dashboard routes. `/ws/devices` answers 404, and MQTT ingest works exactly as before.
3. When `DASHBOARD_ENABLED` is `true`, `/ws/devices` accepts WebSocket connections.
4. A newly connected client first receives one `snapshot` message with every device's current state.
5. After a write that changes a device's state, the api sends one `device` message with that device's current state to every connected client. Heartbeats and replay batches that change nothing send nothing.
6. A replay batch sends at most one `device` message per device: its state after the batch.
7. A client that has disconnected is skipped without error. One slow or broken client does not stop the others from receiving updates.
8. Broadcasting never delays or breaks ingest. A failure while broadcasting is logged at error level, and the heartbeat is still stored.
9. The web app has one page at `/` with a table of devices: device ID, status, battery (%), and last seen (the device's `ts`, in the browser's local time). Rows are sorted by device ID.
10. A snapshot replaces the whole device list. After that, an update only replaces a device's row if its seq is higher than the one shown, and an update for a new device ID adds a row.
11. The page shows the connection state: connecting, live, or reconnecting. If the connection drops, it retries every 2 seconds and applies the new snapshot when it reconnects.
12. The web app connects to the relative path `/ws/devices`. In development, the Angular dev server proxies `/ws` to the api.

## Data

WebSocket messages, api to browser, defined in `@beaconyard/contracts` as `DashboardMessage`:

- `{ "type": "snapshot", "devices": DeviceState[] }`
- `{ "type": "device", "device": DeviceState }`

New config: `DASHBOARD_ENABLED` (off unless exactly `true`), `HTTP_HOST` (default `127.0.0.1`), `HTTP_PORT` (default `3000`).

## Acceptance tests

1. With the flag unset, an HTTP request and a WebSocket upgrade to `/ws/devices` both get 404.
2. With the flag on, a client connecting to `/ws/devices` first receives a `snapshot` containing every device in Mongo.
3. With the flag on, a heartbeat handled after a client connects produces a `device` message with the new state within 1 second.
4. A stale or duplicate heartbeat produces no `device` message.
5. A replay batch that changes a device's state produces exactly one `device` message for it, with the final state.
6. Two connected clients both receive an update. A client that disconnects causes no errors, and the other still receives updates.
7. If broadcasting throws, the heartbeat is still stored and an error is logged.
8. Web store: a snapshot replaces the whole list, including dropping devices not in it. After a snapshot, an update with an equal or lower seq keeps what is shown, a higher seq replaces it, and a new device ID is added.
9. Web page, with a fake connection: one row per device with ID, status, battery, and last seen, sorted by device ID, and the connection state is shown.
10. Web page: after the connection closes, it shows reconnecting, reconnects, and applies the new snapshot.
11. Config: `DASHBOARD_ENABLED` values `false`, `1`, and unset all leave the dashboard off. `HTTP_PORT` and `HTTP_HOST` defaults apply.

## Out of scope

- Authentication. The api listens on localhost only and the flag is off by default.
- Switching the flag without a restart
- Showing event history or rejects
- Alerts (spec 05)
- Serving the built web app from the api
- Browser end-to-end tests
- Replacing the api's logger with Fastify's
- A limit on how much data can queue for a slow browser client. Follow-up work.

## Decisions the agent may NOT make

- Paths, env var names, and message shapes are as written here.
- `fastify` and `@fastify/websocket` are already installed by the human. No other new dependencies.
- The flag is off by default. With it off, the api behaves exactly as it does today, apart from answering 404.
- Existing spec 01 to 03 tests and `pnpm run eval` must still pass.

## Clarifications (from plan review)

- The eval runner starts its api with `HTTP_PORT=0` (any free port), so it never collides with a running dev api. `HTTP_PORT` accepts 0 to 65535.
