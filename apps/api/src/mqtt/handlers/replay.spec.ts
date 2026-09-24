import * as os from 'node:os';
import { MongoClient, MongoNetworkError, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  DEVICE_STATUSES,
  MAX_REPLAY_BATCH,
  type DeviceState,
  type EventRecord,
  type Heartbeat,
  type RejectedMessage,
} from '@beaconyard/contracts';
import type { Logger } from '../../logger';
import { createDeviceStore } from '../../store/devices';
import { createEventStore } from '../../store/events';
import { createRejectStore } from '../../store/rejects';
import { createHeartbeatHandler, type HeartbeatHandler } from './heartbeat';
import {
  createReplayHandler,
  type ReplayDeps,
  type ReplayHandler,
} from './replay';

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let logger: jest.Mocked<Logger>;
let changes: jest.Mock<void, [DeviceState]>;
let replay: ReplayHandler;
let live: HeartbeatHandler;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // same Jest workaround as heartbeat.spec.ts: hand the driver its os adapter
  client = await MongoClient.connect(mongod.getUri(), {
    runtimeAdapters: { os },
  });
  db = client.db('replay-spec');
  await createDeviceStore(db).ensureIndexes();
  await createEventStore(db).ensureIndexes();
}, 30_000);

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await devices().deleteMany({});
  await events().deleteMany({});
  await rejects().deleteMany({});
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  changes = jest.fn();
  replay = makeReplay();
  live = createHeartbeatHandler({
    events: createEventStore(db),
    devices: createDeviceStore(db),
    rejects: createRejectStore(db),
    logger,
    onDeviceChanged: changes,
  });
});

const devices = () => db.collection<DeviceState>('devices');
const events = () => db.collection<EventRecord>('events');
const rejects = () => db.collection<RejectedMessage>('rejects');

function makeReplay(overrides: Partial<ReplayDeps> = {}) {
  return createReplayHandler({
    events: createEventStore(db),
    devices: createDeviceStore(db),
    rejects: createRejectStore(db),
    logger,
    onDeviceChanged: changes,
    ...overrides,
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

// Every field is a function of seq, so two paths sending the same seq send
// identical copies. Pass battery to make copies of one seq tell apart.
function hb(seq: number, battery = seq % 101): Heartbeat {
  return {
    seq,
    ts: `2026-09-24T10:${pad(Math.floor(seq / 60) % 60)}:${pad(seq % 60)}Z`,
    battery,
    status: DEVICE_STATUSES[seq % DEVICE_STATUSES.length],
  };
}

const replayTopic = (deviceId: string) => `devices/${deviceId}/replay`;

// mqtt.js hands the handler a Buffer, so the tests do too
function sendReplay(deviceId: string, entries: unknown[]) {
  return replay(replayTopic(deviceId), Buffer.from(JSON.stringify(entries)));
}

function sendLive(deviceId: string, body: object) {
  return live(
    `devices/${deviceId}/heartbeat`,
    Buffer.from(JSON.stringify(body)),
  );
}

function stateOf(deviceId: string) {
  return devices().findOne({ deviceId }, { projection: { _id: 0 } });
}

function eventsOf(deviceId: string) {
  return events()
    .find({ deviceId }, { projection: { _id: 0 }, sort: { seq: 1 } })
    .toArray();
}

function eventOf(deviceId: string, seq: number) {
  return events().findOne({ deviceId, seq }, { projection: { _id: 0 } });
}

function allRejects() {
  return rejects()
    .find({}, { projection: { _id: 0 } })
    .toArray();
}

// spec 02 AT1/AT2 fixture: state at seq 5 from a live heartbeat, then this
// batch. 7, 12 and 20 repeat, 10/9 and 15/14 are swapped, 2 is stale. Battery
// is unique per entry so a test can tell which copy of a seq was kept.
const AT1_SEQS = [
  6, 7, 8, 10, 9, 11, 12, 13, 15, 14, 16, 17, 18, 19, 20, 21, 2, 7, 12, 20,
];
const at1Batch = AT1_SEQS.map((seq, i) => hb(seq, 50 + i));
const firstCopy = (seq: number) => at1Batch[AT1_SEQS.indexOf(seq)];

async function seedAt1() {
  await sendLive('dev-1', hb(5));
  await sendReplay('dev-1', at1Batch);
}

describe('replay handler', () => {
  it('S02-AT1: a messy batch ends with 18 events, state at seq 21, first copies kept', async () => {
    await seedAt1();

    expect(await events().countDocuments()).toBe(18);
    expect((await eventsOf('dev-1')).map((e) => e.seq)).toEqual([
      2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(await stateOf('dev-1')).toEqual({
      deviceId: 'dev-1',
      ...firstCopy(21),
    });
    expect(await eventOf('dev-1', 2)).toEqual({
      deviceId: 'dev-1',
      ...firstCopy(2),
    });
    for (const seq of [7, 12, 20]) {
      const kept = await eventOf('dev-1', seq);
      expect(kept).toEqual({ deviceId: 'dev-1', ...firstCopy(seq) });
      // and not the later copy
      expect(kept?.battery).not.toBe(
        at1Batch[AT1_SEQS.lastIndexOf(seq)].battery,
      );
    }
    expect(await rejects().countDocuments()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('S02-AT2: the same batch delivered twice changes nothing', async () => {
    await seedAt1();
    const eventsBefore = await eventsOf('dev-1');
    const stateBefore = await stateOf('dev-1');

    await sendReplay('dev-1', at1Batch);

    expect(await events().countDocuments()).toBe(18);
    expect(await eventsOf('dev-1')).toEqual(eventsBefore);
    expect(await stateOf('dev-1')).toEqual(stateBefore);
    expect(await rejects().countDocuments()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('S02-AT3: an invalid entry makes one reject and the rest of the batch is stored', async () => {
    const batch = [hb(1), hb(2), hb(3), { ...hb(4), battery: 150 }, hb(5)];

    await sendReplay('dev-1', batch);

    expect((await eventsOf('dev-1')).map((e) => e.seq)).toEqual([1, 2, 3, 5]);
    expect(await allRejects()).toEqual([
      {
        topic: 'devices/dev-1/replay',
        payload: JSON.stringify(batch[3]),
        reason: expect.stringMatching(/^entry 3: battery /),
        receivedAt: expect.any(Date),
      },
    ]);
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...hb(5) });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        topic: 'devices/dev-1/replay',
        reason: expect.stringMatching(/^entry 3: battery /),
      }),
    );
  });

  it.each([
    ['invalid JSON', '[{"seq": 1,', /^batch: .*JSON/],
    ['a JSON object', JSON.stringify({ entries: [hb(1)] }), /^batch: .*array/],
    [
      `${MAX_REPLAY_BATCH + 1} entries`,
      JSON.stringify(
        Array.from({ length: MAX_REPLAY_BATCH + 1 }, (_, i) => hb(i + 1)),
      ),
      new RegExp(`^batch: .*\\b${MAX_REPLAY_BATCH}\\b`),
    ],
  ])(
    'S02-AT4: %s makes one reject for the whole batch and stores nothing',
    async (_label, raw, reason) => {
      await expect(
        replay(replayTopic('dev-1'), Buffer.from(raw)),
      ).resolves.toBeUndefined();

      expect(await allRejects()).toEqual([
        {
          topic: 'devices/dev-1/replay',
          payload: raw,
          reason: expect.stringMatching(reason),
          receivedAt: expect.any(Date),
        },
      ]);
      expect(await events().countDocuments()).toBe(0);
      expect(await devices().countDocuments()).toBe(0);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it('S02-AT5: an empty batch does nothing', async () => {
    await sendReplay('dev-1', []);

    expect(await events().countDocuments()).toBe(0);
    expect(await devices().countDocuments()).toBe(0);
    expect(await rejects().countDocuments()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('S02-AT8: replay and live heartbeats handled concurrently end in the same state', async () => {
    // A race can pass by luck, so run many rounds of each shape, both call
    // orders, each on a fresh device. Seqs sent both ways have identical
    // contents (see hb), so the result can't depend on who wins.
    const variants = [
      {
        name: 'live-max',
        seed: 0,
        batch: [1, 2, 3, 5, 4, 6, 8, 7, 3],
        live: [2, 6, 9, 10],
      },
      {
        name: 'batch-max',
        seed: 0,
        batch: [4, 5, 6, 8, 7, 9, 10, 12, 11],
        live: [3, 6, 11],
      },
      { name: 'shared-max', seed: 0, batch: [2, 1, 3, 5, 4, 6], live: [4, 6] },
      { name: 'seeded', seed: 5, batch: [3, 6, 4, 8, 7, 5], live: [5, 7, 9] },
    ];
    const checks: { id: string; seqs: number[] }[] = [];

    for (const variant of variants) {
      for (const replayFirst of [true, false]) {
        for (let round = 0; round < 25; round++) {
          const id = `race-${variant.name}-${replayFirst ? 'r' : 'l'}-${round}`;
          if (variant.seed) {
            await sendLive(id, hb(variant.seed));
          }
          const replayCall = () =>
            sendReplay(
              id,
              variant.batch.map((s) => hb(s)),
            );
          const liveCalls = variant.live.map((s) => () => sendLive(id, hb(s)));
          const calls = replayFirst
            ? [replayCall, ...liveCalls]
            : [...liveCalls, replayCall];
          await Promise.all(calls.map((call) => call()));

          const all = [...variant.batch, ...variant.live];
          if (variant.seed) {
            all.push(variant.seed);
          }
          checks.push({ id, seqs: [...new Set(all)].sort((a, b) => a - b) });
        }
      }
    }

    expect(logger.error).not.toHaveBeenCalled();
    expect(await rejects().countDocuments()).toBe(0);
    for (const { id, seqs } of checks) {
      const top = seqs[seqs.length - 1];
      expect(await stateOf(id)).toEqual({ deviceId: id, ...hb(top) });
      expect(await eventsOf(id)).toEqual(
        seqs.map((seq) => ({ deviceId: id, ...hb(seq) })),
      );
    }
  });

  it.each([
    'devices//replay',
    'devices/a/b/replay',
    'devices/a/heartbeat',
    'sensors/a/replay',
  ])(
    'S02-AT9: topic %s is rejected with a reason naming deviceId',
    async (topic) => {
      const raw = JSON.stringify([hb(1)]);

      await replay(topic, Buffer.from(raw));

      expect(await allRejects()).toEqual([
        {
          topic,
          payload: raw,
          reason: expect.stringMatching(/^deviceId/),
          receivedAt: expect.any(Date),
        },
      ]);
      expect(await events().countDocuments()).toBe(0);
      expect(await devices().countDocuments()).toBe(0);
    },
  );

  it('S02-AT11: the highest seq sent twice keeps the first copy in state and history', async () => {
    const first = { ...hb(3), battery: 70, status: 'ok' } as const;
    const second = {
      seq: 3,
      ts: '2026-09-24T11:00:00Z',
      battery: 20,
      status: 'fault',
    } as const;

    await sendReplay('dev-1', [first, hb(1), second]);

    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...first });
    expect(await eventOf('dev-1', 3)).toEqual({ deviceId: 'dev-1', ...first });
    expect(await events().countDocuments()).toBe(2);
  });

  it('keeps the first valid copy when the first copy of a seq is invalid', async () => {
    const bad = { ...hb(7), battery: 150 };
    const good = { ...hb(7), battery: 40 };
    const later = { ...hb(7), battery: 41 };

    await sendReplay('dev-1', [bad, hb(6), good, later]);

    expect(await eventOf('dev-1', 7)).toEqual({ deviceId: 'dev-1', ...good });
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...good });
    expect(await allRejects()).toEqual([
      expect.objectContaining({
        payload: JSON.stringify(bad),
        reason: expect.stringMatching(/^entry 0: battery /),
      }),
    ]);
  });

  it('takes the device ID from the topic and does not store unknown fields', async () => {
    await sendReplay('dev-1', [
      { ...hb(1), firmware: '1.2', deviceId: 'spoofed' },
    ]);

    expect(await eventsOf('dev-1')).toEqual([{ deviceId: 'dev-1', ...hb(1) }]);
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...hb(1) });
    expect(await events().countDocuments({ deviceId: 'spoofed' })).toBe(0);
    expect(await devices().countDocuments()).toBe(1);
  });

  it.each([
    ['seq', { ...hb(3), seq: 0 }, /^entry 1: seq /],
    ['ts', { ...hb(3), ts: '2026-09-24 10:00:00Z' }, /^entry 1: ts /],
    ['status', { ...hb(3), status: 'sleeping' }, /^entry 1: status /],
    ['a non-object', 42, /^entry 1: .*object/],
    ['null', null, /^entry 1: .*object/],
  ])(
    'an entry with bad %s makes one reject naming it',
    async (_label, bad, reason) => {
      await sendReplay('dev-1', [hb(1), bad, hb(2)]);

      expect(await allRejects()).toEqual([
        {
          topic: 'devices/dev-1/replay',
          payload: JSON.stringify(bad),
          reason: expect.stringMatching(reason),
          receivedAt: expect.any(Date),
        },
      ]);
      expect((await eventsOf('dev-1')).map((e) => e.seq)).toEqual([1, 2]);
    },
  );

  it('makes one reject per invalid entry', async () => {
    await sendReplay('dev-1', [
      { ...hb(1), battery: -1 },
      hb(2),
      { ...hb(3), status: 'OK' },
      hb(4),
    ]);

    const reasons = (await allRejects()).map((r) => r.reason).sort();
    expect(reasons).toEqual([
      expect.stringMatching(/^entry 0: battery /),
      expect.stringMatching(/^entry 2: status /),
    ]);
    expect((await eventsOf('dev-1')).map((e) => e.seq)).toEqual([2, 4]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('writes events before state: a failed event write leaves state untouched', async () => {
    const err = new MongoNetworkError('connection lost');
    const failing = makeReplay({
      events: { record: () => Promise.reject(err) },
    });

    await expect(
      failing(replayTopic('dev-1'), Buffer.from(JSON.stringify([hb(1)]))),
    ).resolves.toBeUndefined();

    expect(await devices().countDocuments()).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topic: 'devices/dev-1/replay', err }),
    );
    expect(await rejects().countDocuments()).toBe(0);
  });

  it('does not throw when the state write fails, and history stays ahead of state', async () => {
    const err = new MongoNetworkError('connection lost');
    const failing = makeReplay({
      devices: { applyHeartbeat: () => Promise.reject(err) },
    });

    await expect(
      failing(
        replayTopic('dev-1'),
        Buffer.from(JSON.stringify([hb(1), hb(2)])),
      ),
    ).resolves.toBeUndefined();

    expect(await events().countDocuments()).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topic: 'devices/dev-1/replay', err }),
    );
  });

  it('still stores valid entries when storing entry rejects fails', async () => {
    const err = new MongoNetworkError('connection lost');
    const failing = makeReplay({
      rejects: {
        insert: () => Promise.reject(err),
        insertMany: () => Promise.reject(err),
      },
    });

    await expect(
      failing(
        replayTopic('dev-1'),
        Buffer.from(JSON.stringify([hb(1), { ...hb(2), battery: 150 }, hb(3)])),
      ),
    ).resolves.toBeUndefined();

    expect((await eventsOf('dev-1')).map((e) => e.seq)).toEqual([1, 3]);
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...hb(3) });
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        topic: 'devices/dev-1/replay',
        reasons: [expect.stringMatching(/^entry 1: battery /)],
        err,
      }),
    );
  });

  it('does not throw when storing a whole-batch reject fails', async () => {
    const err = new MongoNetworkError('connection lost');
    const failing = makeReplay({
      rejects: {
        insert: () => Promise.reject(err),
        insertMany: () => Promise.reject(err),
      },
    });

    await expect(
      failing(replayTopic('dev-1'), Buffer.from('not json')),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        topic: 'devices/dev-1/replay',
        reason: expect.stringMatching(/^batch: /),
        err,
      }),
    );
  });

  it('S04-AT5: a batch that changes state reports once, with the first copy of its highest seq', async () => {
    await seedAt1();

    expect(changes.mock.calls).toEqual([
      // the live seq 5 that seeds the fixture
      [{ deviceId: 'dev-1', ...hb(5) }],
      [{ deviceId: 'dev-1', ...firstCopy(21) }],
    ]);
  });

  it('S04-AT4: the same batch delivered twice reports only the first time', async () => {
    await seedAt1();
    changes.mockClear();

    await sendReplay('dev-1', at1Batch);

    expect(changes).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('S04-AT4: a batch with nothing newer than the stored state reports no change', async () => {
    await sendLive('dev-1', hb(10));
    changes.mockClear();

    await sendReplay('dev-1', [hb(3), hb(7), hb(10), hb(9)]);

    expect(changes).not.toHaveBeenCalled();
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...hb(10) });
    expect((await eventsOf('dev-1')).map((e) => e.seq)).toEqual([3, 7, 9, 10]);
  });

  it('S04-AT7: a broadcast that throws still stores the batch and logs an error', async () => {
    const err = new Error('broadcast blew up');
    const failing = makeReplay({
      onDeviceChanged: () => {
        throw err;
      },
    });

    await expect(
      failing(
        replayTopic('dev-1'),
        Buffer.from(JSON.stringify([hb(1), hb(2)])),
      ),
    ).resolves.toBeUndefined();

    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...hb(2) });
    expect((await eventsOf('dev-1')).map((e) => e.seq)).toEqual([1, 2]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        topic: 'devices/dev-1/replay',
        deviceId: 'dev-1',
        err,
      }),
    );
  });
});
