# 05. Low-battery alert

## Why

A device with a dying battery goes silent, and today nobody finds out until it is gone. Other systems (a pager, an email service) need a message when a battery gets low. It must arrive once per low-battery episode, not with every heartbeat, or people learn to ignore it.

## Behavior

1. Each time a heartbeat or replay changes a device's state (the change signal from spec 04), the api evaluates the low-battery rule for that state. Alerts run whether or not the dashboard is enabled.
2. Each device is either armed or alerted for low battery. A device with no alert history is armed.
3. When the state's battery is below `ALERT_LOW_BATTERY_BELOW` (default 15) and the device is armed, the device becomes alerted and the api publishes one alert.
4. When the state's battery is at or above `ALERT_REARM_AT` (default 20) and the device is alerted, it becomes armed again. Nothing is published.
5. A battery from 15 to 19 changes nothing.
6. The rule applies states in seq order per device. A state whose seq is lower than or equal to the last seq the rule applied for that device is ignored, because changes can reach listeners out of order (spec 04).
7. Each armed or alerted transition is one atomic Mongo operation, so concurrent states cannot publish the same alert twice. There is no read-then-write, and a device that is already alerted does not travel an error path.
8. The alert state is stored before the alert is published. If publishing fails, the error is logged and that alert is not retried.
9. A replay batch is evaluated only on its final state, since spec 04 sends one change per batch.
10. Evaluating or publishing an alert never delays or breaks ingest, and never throws out of a handler.

## Data

Alert message on `alerts/{deviceId}`, QoS 1, not retained. Payload `LowBatteryAlert`, in `@beaconyard/contracts`:
`{ "type": "low-battery", "deviceId", "seq", "ts", "battery" }`, taken from the state that triggered it. `deviceId` plus `seq` identify the alert, so a consumer can ignore a copy.

Collection `alertStates` (`AlertState`, in `@beaconyard/contracts`): `deviceId` (unique), `seq` (the last seq the rule applied), `lowBattery` (`"armed"` or `"alerted"`).

New config: `ALERT_LOW_BATTERY_BELOW` (default 15) and `ALERT_REARM_AT` (default 20). Both are integers from 0 to 100, and `ALERT_REARM_AT` must be greater than `ALERT_LOW_BATTERY_BELOW`. Anything else fails startup.

## Acceptance tests

1. Battery 50, then 10: exactly one alert on `alerts/{deviceId}`, with the payload above and battery 10.
2. After that alert, newer heartbeats at 9, 8, and 12 publish nothing.
3. After an alert, 17 then 10 publish nothing.
4. After an alert, 25 then 10 publish a second alert, carrying the seq and battery of the 10% heartbeat.
5. Boundaries: 15 never alerts. After an alert, 20 re-arms and 19 does not.
6. A new device whose first heartbeat is at 5% gets one alert.
7. A stale or duplicate heartbeat with a low battery publishes nothing.
8. The rule receives seq 7 at 50%, then seq 6 at 10%: nothing is published.
9. Low-battery states for the same device handled concurrently with `Promise.all`, across many rounds: exactly one alert per round.
10. A replay batch with a 10% entry that ends at 80% publishes nothing. A batch that ends at 10% on an armed device publishes one alert.
11. After an alert, a new handler over the same Mongo (as after an api restart) receives another low heartbeat and publishes nothing.
12. If publishing throws: the device is still alerted, an error is logged, the heartbeat is stored, the handler resolves, and the next low heartbeat publishes nothing.
13. With `DASHBOARD_ENABLED` unset, alerts still publish.
14. Config: the defaults are 15 and 20. A non-integer, a value outside 0 to 100, or `ALERT_REARM_AT` not greater than `ALERT_LOW_BATTERY_BELOW` fails startup.

## Out of scope

- Retrying a failed alert publish. A failure means that alert is missed; it is logged.
- Other alert types
- Showing alerts on the dashboard
- Keeping a history of alerts
- Alerting on a low battery in the middle of a replay batch
- Eval scenarios for alerts. The harness compares devices, events, and rejects only.

## Decisions the agent may NOT make

- Thresholds, topic, payload, collection name, and env var names are as written here.
- The seq-order rule and the single atomic transition are required. If one operation cannot express them, stop and ask.
- No new dependencies.
- Existing spec 01 to 04 tests and `pnpm run eval` must still pass. The dashboard behaves exactly as before.

## Clarifications (from plan review)

- Every state with a seq newer than the stored seq moves the stored seq forward, including batteries from 15 to 19. Only `lowBattery` stays unchanged in that band.
- An empty `ALERT_LOW_BATTERY_BELOW` or `ALERT_REARM_AT` falls back to the default, like `HTTP_PORT`.
