import * as os from 'node:os';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { DeviceState, Heartbeat } from '@beaconyard/contracts';
import { createLowBatteryRule, type AlertPublish } from './alerts/low-battery';
import { loadConfig, type Config } from './config';
import { createDeviceChangedListener } from './device-changed';
import type { Logger } from './logger';
import { createHeartbeatHandler } from './mqtt/handlers/heartbeat';
import { createAlertStateStore } from './store/alert-states';
import { createDeviceStore } from './store/devices';
import { createEventStore } from './store/events';
import { createRejectStore } from './store/rejects';
import type { DashboardHub } from './ws/dashboard';

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let logger: jest.Mocked<Logger>;
let publish: jest.Mock<Promise<unknown>, Parameters<AlertPublish>>;
// resolves with the first publish's arguments
let published: Promise<Parameters<AlertPublish>>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // same Jest workaround as heartbeat.spec.ts: hand the driver its os adapter
  client = await MongoClient.connect(mongod.getUri(), {
    runtimeAdapters: { os },
  });
  db = client.db('device-changed-spec');
  await createDeviceStore(db).ensureIndexes();
  await createEventStore(db).ensureIndexes();
  await createAlertStateStore(db).ensureIndexes();
}, 30_000);

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all(
    ['devices', 'events', 'rejects', 'alertStates'].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  published = new Promise((resolve) => {
    publish = jest.fn<Promise<unknown>, Parameters<AlertPublish>>(
      async (...args) => resolve(args),
    );
  });
});

function makeRule(config: Config) {
  return createLowBatteryRule({
    alertStates: createAlertStateStore(db),
    publish,
    logger,
    lowBatteryBelow: config.alertLowBatteryBelow,
    rearmAt: config.alertRearmAt,
  });
}

function makeHandler(onDeviceChanged: (state: DeviceState) => void) {
  return createHeartbeatHandler({
    events: createEventStore(db),
    devices: createDeviceStore(db),
    rejects: createRejectStore(db),
    logger,
    onDeviceChanged,
  });
}

function hb(seq: number, battery: number): Heartbeat {
  return { seq, ts: `2026-09-24T10:00:0${seq}Z`, battery, status: 'ok' };
}

const heartbeatBody = (seq: number, battery: number) =>
  Buffer.from(JSON.stringify(hb(seq, battery)));

describe('device changed listener', () => {
  it('S05-AT13: with DASHBOARD_ENABLED unset, alerts still publish', async () => {
    const config = loadConfig({});
    expect(config.dashboardEnabled).toBe(false);
    const fakeHub: Pick<DashboardHub, 'publish'> = { publish: jest.fn() };

    // the same choice main.ts makes: no hub unless the flag is on
    const handle = makeHandler(
      createDeviceChangedListener({
        dashboard: config.dashboardEnabled ? fakeHub : undefined,
        lowBattery: makeRule(config),
      }),
    );
    await handle('devices/dev-1/heartbeat', heartbeatBody(1, 10));

    const [topic, payload, opts] = await published;
    expect(topic).toBe('alerts/dev-1');
    expect(opts).toEqual({ qos: 1, retain: false });
    expect(JSON.parse(payload)).toEqual({
      type: 'low-battery',
      deviceId: 'dev-1',
      seq: 1,
      ts: '2026-09-24T10:00:01Z',
      battery: 10,
    });
    expect(fakeHub.publish).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('passes every change to the dashboard exactly as before, alongside the alert', async () => {
    const hub = { publish: jest.fn() };
    const handle = makeHandler(
      createDeviceChangedListener({
        dashboard: hub,
        lowBattery: makeRule(loadConfig({})),
      }),
    );

    await handle('devices/dev-1/heartbeat', heartbeatBody(1, 50));
    await handle('devices/dev-1/heartbeat', heartbeatBody(2, 10));
    // a duplicate changes nothing, so the hub hears nothing
    await handle('devices/dev-1/heartbeat', heartbeatBody(2, 10));

    expect(hub.publish.mock.calls).toEqual([
      [{ deviceId: 'dev-1', ...hb(1, 50) }],
      [{ deviceId: 'dev-1', ...hb(2, 10) }],
    ]);
    const [topic, payload] = await published;
    expect(topic).toBe('alerts/dev-1');
    expect(JSON.parse(payload)).toEqual(
      expect.objectContaining({ seq: 2, battery: 10 }),
    );
  });

  it('still runs the alert rule when the dashboard throws, and the handler logs the broadcast failure as before', async () => {
    const err = new Error('broadcast blew up');
    const handle = makeHandler(
      createDeviceChangedListener({
        dashboard: {
          publish: () => {
            throw err;
          },
        },
        lowBattery: makeRule(loadConfig({})),
      }),
    );

    await expect(
      handle('devices/dev-1/heartbeat', heartbeatBody(1, 10)),
    ).resolves.toBeUndefined();

    const [topic] = await published;
    expect(topic).toBe('alerts/dev-1');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'device broadcast failed',
      expect.objectContaining({
        topic: 'devices/dev-1/heartbeat',
        deviceId: 'dev-1',
        err,
      }),
    );
  });

  it('returns without waiting for the alert rule', () => {
    const hub = { publish: jest.fn() };
    const evaluate = jest.fn(() => new Promise<void>(() => undefined));
    const listener = createDeviceChangedListener({
      dashboard: hub,
      lowBattery: { evaluate },
    });
    const state = { deviceId: 'dev-1', ...hb(1, 10) };

    expect(listener(state)).toBeUndefined();

    expect(evaluate).toHaveBeenCalledWith(state);
    expect(hub.publish).toHaveBeenCalledWith(state);
  });
});
