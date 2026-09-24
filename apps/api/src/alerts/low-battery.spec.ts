import * as os from 'node:os';
import { MongoClient, MongoNetworkError, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type {
  AlertState,
  DeviceState,
  EventRecord,
  Heartbeat,
  LowBatteryAlert,
  RejectedMessage,
} from '@beaconyard/contracts';
import { loadConfig } from '../config';
import { createDeviceChangedListener } from '../device-changed';
import type { Logger } from '../logger';
import { createHeartbeatHandler } from '../mqtt/handlers/heartbeat';
import { createReplayHandler } from '../mqtt/handlers/replay';
import { createAlertStateStore } from '../store/alert-states';
import { createDeviceStore } from '../store/devices';
import { createEventStore } from '../store/events';
import { createRejectStore } from '../store/rejects';
import {
  createLowBatteryRule,
  type AlertPublish,
  type LowBatteryRule,
  type LowBatteryRuleDeps,
} from './low-battery';

// the spec's thresholds are the config defaults, 15 and 20
const { alertLowBatteryBelow, alertRearmAt } = loadConfig({});

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let logger: jest.Mocked<Logger>;
let publish: jest.Mock<Promise<unknown>, Parameters<AlertPublish>>;
// evaluate() calls the handlers started and didn't wait for
let inflight: Promise<void>[];
let handlers: ReturnType<typeof makeHandlers>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // same Jest workaround as heartbeat.spec.ts: hand the driver its os adapter
  client = await connect();
  db = client.db('low-battery-spec');
  await createDeviceStore(db).ensureIndexes();
  await createEventStore(db).ensureIndexes();
  await createAlertStateStore(db).ensureIndexes();
}, 30_000);

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await devices().deleteMany({});
  await events().deleteMany({});
  await rejects().deleteMany({});
  await alertStates().deleteMany({});
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  publish = succeedingPublish();
  inflight = [];
  handlers = makeHandlers();
});

function succeedingPublish() {
  return jest.fn<Promise<unknown>, Parameters<AlertPublish>>(() =>
    Promise.resolve(),
  );
}

function connect() {
  return MongoClient.connect(mongod.getUri(), { runtimeAdapters: { os } });
}

const devices = () => db.collection<DeviceState>('devices');
const events = () => db.collection<EventRecord>('events');
const rejects = () => db.collection<RejectedMessage>('rejects');
const alertStates = () => db.collection<AlertState>('alertStates');

function makeRule(overrides: Partial<LowBatteryRuleDeps> = {}) {
  return createLowBatteryRule({
    alertStates: createAlertStateStore(db),
    publish,
    logger,
    lowBatteryBelow: alertLowBatteryBelow,
    rearmAt: alertRearmAt,
    ...overrides,
  });
}

// Real handlers wired through the real change listener, the way main.ts does
// it. The listener doesn't wait for the rule, so keep hold of each evaluate()
// to await it in settle().
function makeHandlers(rule: LowBatteryRule = makeRule(), target: Db = db) {
  const onDeviceChanged = createDeviceChangedListener({
    lowBattery: {
      evaluate(state) {
        const done = rule.evaluate(state);
        inflight.push(done);
        return done;
      },
    },
  });
  const deps = {
    events: createEventStore(target),
    devices: createDeviceStore(target),
    rejects: createRejectStore(target),
    logger,
    onDeviceChanged,
  };
  return {
    heartbeat: createHeartbeatHandler(deps),
    replay: createReplayHandler(deps),
  };
}

async function settle() {
  while (inflight.length > 0) {
    await Promise.all(inflight.splice(0));
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

// ts is a function of seq, so a payload's ts shows which heartbeat it came from
function hb(seq: number, battery: number): Heartbeat {
  return {
    seq,
    ts: `2026-09-24T10:${pad(Math.floor(seq / 60) % 60)}:${pad(seq % 60)}Z`,
    battery,
    status: 'ok',
  };
}

const stateFor = (deviceId: string, seq: number, battery: number) => ({
  deviceId,
  ...hb(seq, battery),
});

const alertFor = (
  deviceId: string,
  seq: number,
  battery: number,
): LowBatteryAlert => ({
  type: 'low-battery',
  deviceId,
  seq,
  ts: hb(seq, battery).ts,
  battery,
});

// mqtt.js hands the handler a Buffer, so the tests do too
function deliver(deviceId: string, body: Heartbeat) {
  return handlers.heartbeat(
    `devices/${deviceId}/heartbeat`,
    Buffer.from(JSON.stringify(body)),
  );
}

// one heartbeat at a time, rule finished before the next
async function send(deviceId: string, seq: number, battery: number) {
  await deliver(deviceId, hb(seq, battery));
  await settle();
}

async function sendReplay(deviceId: string, entries: Heartbeat[]) {
  await handlers.replay(
    `devices/${deviceId}/replay`,
    Buffer.from(JSON.stringify(entries)),
  );
  await settle();
}

// alerts published for this device, payloads parsed
function alertsFor(deviceId: string): LowBatteryAlert[] {
  return publish.mock.calls
    .filter(([topic]) => topic === `alerts/${deviceId}`)
    .map(([, payload]) => JSON.parse(payload) as LowBatteryAlert);
}

function alertStateOf(deviceId: string) {
  return alertStates().findOne({ deviceId }, { projection: { _id: 0 } });
}

describe('low-battery rule', () => {
  it('S05-AT1: battery 50 then 10 publishes exactly one alert with the 10% heartbeat', async () => {
    await send('dev-1', 1, 50);
    await send('dev-1', 2, 10);

    expect(publish.mock.calls).toEqual([
      ['alerts/dev-1', expect.any(String), { qos: 1, retain: false }],
    ]);
    expect(JSON.parse(publish.mock.calls[0][1])).toEqual({
      type: 'low-battery',
      deviceId: 'dev-1',
      seq: 2,
      ts: '2026-09-24T10:00:02Z',
      battery: 10,
    });
    // exactly the AlertState fields, nothing else
    expect(await alertStateOf('dev-1')).toEqual({
      deviceId: 'dev-1',
      seq: 2,
      lowBattery: 'alerted',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('S05-AT2: after an alert, newer heartbeats at 9, 8 and 12 publish nothing', async () => {
    await send('dev-1', 1, 50);
    await send('dev-1', 2, 10);
    expect(alertsFor('dev-1')).toHaveLength(1);

    await send('dev-1', 3, 9);
    await send('dev-1', 4, 8);
    await send('dev-1', 5, 12);

    expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 2, 10)]);
    expect(await alertStateOf('dev-1')).toEqual({
      deviceId: 'dev-1',
      seq: 5,
      lowBattery: 'alerted',
    });
  });

  it('S05-AT3: after an alert, 17 then 10 publish nothing', async () => {
    await send('dev-1', 1, 10);
    expect(alertsFor('dev-1')).toHaveLength(1);

    await send('dev-1', 2, 17);
    await send('dev-1', 3, 10);

    expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 1, 10)]);
    expect(await alertStateOf('dev-1')).toEqual({
      deviceId: 'dev-1',
      seq: 3,
      lowBattery: 'alerted',
    });
  });

  it('S05-AT4: after an alert, 25 then 10 publish a second alert for the 10% heartbeat', async () => {
    await send('dev-1', 1, 50);
    await send('dev-1', 2, 10);
    await send('dev-1', 3, 25);
    expect(alertsFor('dev-1')).toHaveLength(1);

    await send('dev-1', 4, 10);

    expect(alertsFor('dev-1')).toEqual([
      alertFor('dev-1', 2, 10),
      alertFor('dev-1', 4, 10),
    ]);
  });

  describe('S05-AT5: boundaries', () => {
    it('15 never alerts, for a new device or one dropping from 50', async () => {
      await send('dev-a', 1, 15);
      await send('dev-b', 1, 50);
      await send('dev-b', 2, 15);

      expect(publish).not.toHaveBeenCalled();
      expect(await alertStateOf('dev-a')).toEqual({
        deviceId: 'dev-a',
        seq: 1,
        lowBattery: 'armed',
      });
      expect(await alertStateOf('dev-b')).toEqual({
        deviceId: 'dev-b',
        seq: 2,
        lowBattery: 'armed',
      });
    });

    it('14 alerts', async () => {
      await send('dev-1', 1, 50);
      await send('dev-1', 2, 14);

      expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 2, 14)]);
    });

    it('after an alert, 19 does not re-arm', async () => {
      await send('dev-1', 1, 10);
      await send('dev-1', 2, 19);

      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 2,
        lowBattery: 'alerted',
      });

      await send('dev-1', 3, 10);

      expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 1, 10)]);
    });

    it('after an alert, 20 re-arms without publishing', async () => {
      await send('dev-1', 1, 10);
      await send('dev-1', 2, 20);

      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 2,
        lowBattery: 'armed',
      });
      expect(alertsFor('dev-1')).toHaveLength(1);

      await send('dev-1', 3, 10);

      expect(alertsFor('dev-1')).toEqual([
        alertFor('dev-1', 1, 10),
        alertFor('dev-1', 3, 10),
      ]);
    });
  });

  it('S05-AT6: a new device whose first heartbeat is at 5% gets one alert', async () => {
    await send('dev-1', 1, 5);

    expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 1, 5)]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  describe('S05-AT7: stale and duplicate heartbeats', () => {
    it('a stale low heartbeat publishes nothing', async () => {
      await send('dev-1', 5, 50);
      await send('dev-1', 4, 10);

      expect(publish).not.toHaveBeenCalled();
      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 5,
        lowBattery: 'armed',
      });

      // the device is still armed, so a newer low heartbeat does alert
      await send('dev-1', 6, 10);
      expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 6, 10)]);
    });

    it('a duplicate seq with a low battery publishes nothing', async () => {
      await send('dev-1', 5, 50);
      // same message ID, different body
      await send('dev-1', 5, 10);

      expect(publish).not.toHaveBeenCalled();
      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 5,
        lowBattery: 'armed',
      });
    });

    it('the alerting heartbeat sent twice publishes once', async () => {
      await send('dev-1', 5, 50);
      await send('dev-1', 6, 10);
      await send('dev-1', 6, 10);

      expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 6, 10)]);
    });
  });

  it('S05-AT8: seq 7 at 50% then seq 6 at 10% publishes nothing', async () => {
    // straight into the rule: the device store would never pass 6 after 7,
    // but two handlers can hand their changes over in the wrong order
    const rule = makeRule();

    await rule.evaluate(stateFor('dev-1', 7, 50));
    await rule.evaluate(stateFor('dev-1', 6, 10));

    expect(publish).not.toHaveBeenCalled();
    expect(await alertStateOf('dev-1')).toEqual({
      deviceId: 'dev-1',
      seq: 7,
      lowBattery: 'armed',
    });

    await rule.evaluate(stateFor('dev-1', 8, 10));
    expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 8, 10)]);
  });

  describe('S05-AT9: concurrent low states', () => {
    it('alert exactly once per round, for new and armed devices', async () => {
      // A race can pass by luck, so run each shape many times. The new-device
      // shapes make several upserts race to insert the first doc.
      const rule = makeRule();
      const variants = [
        { name: 'new-dup', armed: false, seqs: [1, 1] },
        { name: 'new-asc', armed: false, seqs: [1, 2, 3, 4] },
        { name: 'new-desc', armed: false, seqs: [4, 3, 2, 1] },
        { name: 'armed-dup', armed: true, seqs: [2, 2] },
        { name: 'armed-asc', armed: true, seqs: [2, 3, 4, 5] },
        { name: 'armed-desc', armed: true, seqs: [5, 4, 3, 2] },
      ];
      const rounds: { id: string; seqs: number[] }[] = [];

      for (const { name, armed, seqs } of variants) {
        for (let round = 0; round < 25; round++) {
          const id = `race-${name}-${round}`;
          rounds.push({ id, seqs });
          if (armed) {
            await rule.evaluate(stateFor(id, 1, 50));
          }
          await Promise.all(
            seqs.map((seq) => rule.evaluate(stateFor(id, seq, 5 + seq))),
          );
        }
      }

      expect(logger.error).not.toHaveBeenCalled();
      for (const { id, seqs } of rounds) {
        const sent = alertsFor(id);
        expect(sent).toHaveLength(1);
        expect(seqs).toContain(sent[0].seq);
        expect(sent[0]).toEqual(alertFor(id, sent[0].seq, 5 + sent[0].seq));
        expect(await alertStateOf(id)).toEqual({
          deviceId: id,
          seq: Math.max(...seqs),
          lowBattery: 'alerted',
        });
      }
    });

    it('one device re-armed between rounds alerts exactly once per round', async () => {
      const rule = makeRule();
      let seq = 0;

      for (let round = 0; round < 25; round++) {
        await rule.evaluate(stateFor('dev-1', ++seq, 80));
        const lows = [++seq, ++seq, ++seq];
        if (round % 2 === 1) {
          lows.reverse();
        }
        await Promise.all(
          lows.map((s) => rule.evaluate(stateFor('dev-1', s, 10))),
        );

        expect(alertsFor('dev-1')).toHaveLength(round + 1);
      }
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('low heartbeats through the handler alert exactly once per round', async () => {
      const shapes = [
        [1, 1],
        [1, 2],
        [2, 1],
      ];
      const ids: string[] = [];

      for (const seqs of shapes) {
        for (let round = 0; round < 25; round++) {
          const id = `handler-${seqs.join('-')}-${round}`;
          ids.push(id);
          await Promise.all(seqs.map((seq) => deliver(id, hb(seq, 5 + seq))));
        }
      }
      await settle();

      expect(logger.error).not.toHaveBeenCalled();
      for (const id of ids) {
        expect(alertsFor(id)).toHaveLength(1);
      }
    });
  });

  describe('S05-AT10: replay batches', () => {
    it('a batch with a 10% entry that ends at 80% publishes nothing', async () => {
      await sendReplay('dev-1', [hb(1, 60), hb(2, 10), hb(3, 80)]);

      expect(publish).not.toHaveBeenCalled();
      // the rule did run, on the batch's final state
      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 3,
        lowBattery: 'armed',
      });
    });

    it('a batch that ends at 10% on an armed device publishes one alert', async () => {
      await send('dev-1', 1, 50);

      await sendReplay('dev-1', [hb(2, 80), hb(3, 40), hb(4, 10)]);

      expect(alertsFor('dev-1')).toEqual([alertFor('dev-1', 4, 10)]);
    });
  });

  it('S05-AT11: after a restart over the same Mongo, another low heartbeat publishes nothing', async () => {
    await send('dev-1', 1, 50);
    await send('dev-1', 2, 10);
    expect(alertsFor('dev-1')).toHaveLength(1);

    // new connection, stores, rule and handlers, as a restarted api would have
    const restarted = await connect();
    try {
      const restartedDb = restarted.db(db.databaseName);
      const restartedPublish = succeedingPublish();
      handlers = makeHandlers(
        makeRule({
          alertStates: createAlertStateStore(restartedDb),
          publish: restartedPublish,
        }),
        restartedDb,
      );

      await send('dev-1', 3, 9);

      expect(restartedPublish).not.toHaveBeenCalled();
      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 3,
        lowBattery: 'alerted',
      });
    } finally {
      await restarted.close();
    }
  });

  it.each([
    ['rejects', (err: Error) => () => Promise.reject<unknown>(err)],
    [
      'throws synchronously',
      (err: Error) => (): Promise<unknown> => {
        throw err;
      },
    ],
  ])(
    'S05-AT12: when publish %s the device stays alerted and the next low heartbeat publishes nothing',
    async (_label, failWith) => {
      const err = new Error('broker gone');
      publish.mockImplementationOnce(failWith(err));

      await expect(deliver('dev-1', hb(1, 10))).resolves.toBeUndefined();
      await settle();

      expect(publish).toHaveBeenCalledTimes(1);
      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 1,
        lowBattery: 'alerted',
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deviceId: 'dev-1', seq: 1, err }),
      );
      expect(
        await devices().findOne(
          { deviceId: 'dev-1' },
          { projection: { _id: 0 } },
        ),
      ).toEqual({ deviceId: 'dev-1', ...hb(1, 10) });
      expect(await events().countDocuments({ deviceId: 'dev-1', seq: 1 })).toBe(
        1,
      );

      await send('dev-1', 2, 8);

      // not retried, and no new alert
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await alertStateOf('dev-1')).toEqual({
        deviceId: 'dev-1',
        seq: 2,
        lowBattery: 'alerted',
      });
    },
  );

  it('stores the alerted state before publishing', async () => {
    const seen: (AlertState | null)[] = [];
    publish.mockImplementation(async () => {
      seen.push(await alertStateOf('dev-1'));
    });

    await send('dev-1', 1, 10);

    expect(seen).toEqual([
      { deviceId: 'dev-1', seq: 1, lowBattery: 'alerted' },
    ]);
  });

  it('does not hold up the handler while a publish is still pending', async () => {
    let publishCalled!: () => void;
    const called = new Promise<void>((resolve) => (publishCalled = resolve));
    publish.mockImplementation(() => {
      publishCalled();
      // never settles, like a publish waiting on a broker that's gone
      return new Promise(() => undefined);
    });

    await expect(deliver('dev-1', hb(1, 10))).resolves.toBeUndefined();

    expect(
      await devices().findOne(
        { deviceId: 'dev-1' },
        { projection: { _id: 0 } },
      ),
    ).toEqual({ deviceId: 'dev-1', ...hb(1, 10) });
    await called;
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('logs a failing alert state write without breaking ingest or publishing', async () => {
    const err = new MongoNetworkError('connection lost');
    handlers = makeHandlers(
      makeRule({
        alertStates: { applyLowBattery: () => Promise.reject(err) },
      }),
    );

    await expect(deliver('dev-1', hb(1, 10))).resolves.toBeUndefined();
    await settle();

    expect(publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deviceId: 'dev-1', seq: 1, err }),
    );
    expect(
      await devices().findOne(
        { deviceId: 'dev-1' },
        { projection: { _id: 0 } },
      ),
    ).toEqual({ deviceId: 'dev-1', ...hb(1, 10) });
  });
});
