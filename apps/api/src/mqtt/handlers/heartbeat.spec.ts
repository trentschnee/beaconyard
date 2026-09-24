import * as os from 'node:os';
import { MongoClient, MongoNetworkError, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { DeviceState, RejectedMessage } from '@beaconyard/contracts';
import type { Logger } from '../../logger';
import { createDeviceStore } from '../../store/devices';
import { createRejectStore } from '../../store/rejects';
import { createHeartbeatHandler, type HeartbeatHandler } from './heartbeat';

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let logger: jest.Mocked<Logger>;
let handle: HeartbeatHandler;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // The driver loads its os adapter with a dynamic import(), which Jest's CJS
  // vm rejects. The driver swallows that, sends empty client metadata, and
  // mongod refuses the handshake. Hand it the adapter directly. Only the test
  // needs this; plain node is fine.
  client = await MongoClient.connect(mongod.getUri(), {
    runtimeAdapters: { os },
  });
  db = client.db('heartbeat-spec');
  await createDeviceStore(db).ensureIndexes();
}, 30_000);

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await devices().deleteMany({});
  await rejects().deleteMany({});
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  handle = createHeartbeatHandler({
    devices: createDeviceStore(db),
    rejects: createRejectStore(db),
    logger,
  });
});

const devices = () => db.collection<DeviceState>('devices');
const rejects = () => db.collection<RejectedMessage>('rejects');

// every field differs between seqs so a test can tell which message won
const seq4 = {
  seq: 4,
  ts: '2026-09-23T10:04:00Z',
  battery: 20,
  status: 'fault',
} as const;
const seq5 = {
  seq: 5,
  ts: '2026-09-23T10:05:00Z',
  battery: 80,
  status: 'ok',
} as const;
const seq6 = {
  seq: 6,
  ts: '2026-09-23T10:06:00Z',
  battery: 60,
  status: 'warning',
} as const;

const topicFor = (deviceId: string) => `devices/${deviceId}/heartbeat`;

// mqtt.js hands the handler a Buffer, so the tests do too
function send(deviceId: string, body: object) {
  return handle(topicFor(deviceId), Buffer.from(JSON.stringify(body)));
}

function stateOf(deviceId: string) {
  return devices().findOne({ deviceId }, { projection: { _id: 0 } });
}

function allRejects() {
  return rejects()
    .find({}, { projection: { _id: 0 } })
    .toArray();
}

describe('heartbeat handler', () => {
  it('AT1: a valid heartbeat for a new device creates one devices document', async () => {
    const body = {
      seq: 1,
      ts: '2026-09-23T10:00:00.123+02:00',
      battery: 90,
      status: 'ok',
    };

    await send('dev-1', body);

    expect(await devices().countDocuments()).toBe(1);
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...body });
    expect(await rejects().countDocuments()).toBe(0);
  });

  it('AT2: seq 5 then seq 4 keeps seq 5', async () => {
    await send('dev-1', seq5);
    await send('dev-1', seq4);

    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...seq5 });
    expect(await rejects().countDocuments()).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('AT3: seq 4 then seq 5 moves to seq 5', async () => {
    await send('dev-1', seq4);
    await send('dev-1', seq5);

    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...seq5 });
  });

  it('AT4: seq 5 twice leaves one unchanged document and no rejects', async () => {
    await send('dev-1', seq5);
    await send('dev-1', seq5);
    // same message ID with a different body still loses to what's stored
    await send('dev-1', { ...seq6, seq: 5 });

    expect(await devices().countDocuments()).toBe(1);
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...seq5 });
    expect(await rejects().countDocuments()).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('AT5: seq 5 and seq 6 handled concurrently end at seq 6', async () => {
    // A race can pass by luck, so run it many times: both call orders, for a
    // brand-new device (both upserts may try to insert) and for one that
    // already has state.
    const variants = [
      { name: 'new-5-first', seeded: false, order: [seq5, seq6] },
      { name: 'new-6-first', seeded: false, order: [seq6, seq5] },
      { name: 'seeded-5-first', seeded: true, order: [seq5, seq6] },
      { name: 'seeded-6-first', seeded: true, order: [seq6, seq5] },
    ];
    const ids: string[] = [];

    for (const variant of variants) {
      for (let round = 0; round < 25; round++) {
        const id = `race-${variant.name}-${round}`;
        ids.push(id);
        if (variant.seeded) {
          await send(id, seq4);
        }
        await Promise.all(variant.order.map((body) => send(id, body)));
      }
    }

    expect(logger.error).not.toHaveBeenCalled();
    expect(await devices().countDocuments()).toBe(ids.length);
    for (const id of ids) {
      expect(await stateOf(id)).toEqual({ deviceId: id, ...seq6 });
    }
  });

  it('AT6: malformed JSON is rejected without throwing', async () => {
    const raw = '{"seq": 5, "ts": ';

    await expect(
      handle(topicFor('dev-1'), Buffer.from(raw)),
    ).resolves.toBeUndefined();

    const stored = await allRejects();
    expect(stored).toEqual([
      {
        topic: 'devices/dev-1/heartbeat',
        payload: raw,
        reason: expect.stringMatching(/JSON/),
        receivedAt: expect.any(Date),
      },
    ]);
    expect(await devices().countDocuments()).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        topic: 'devices/dev-1/heartbeat',
        reason: stored[0].reason,
      }),
    );
  });

  it('AT7: battery 150 is rejected with a reason naming battery', async () => {
    const body = { ...seq5, battery: 150 };

    await send('dev-1', body);

    expect(await allRejects()).toEqual([
      {
        topic: 'devices/dev-1/heartbeat',
        payload: JSON.stringify(body),
        reason: expect.stringMatching(/^battery /),
        receivedAt: expect.any(Date),
      },
    ]);
    expect(await devices().countDocuments()).toBe(0);
  });

  it('AT8: status "sleeping" is rejected with a reason naming status', async () => {
    const body = { ...seq5, status: 'sleeping' };

    await send('dev-1', body);

    expect(await allRejects()).toEqual([
      {
        topic: 'devices/dev-1/heartbeat',
        payload: JSON.stringify(body),
        reason: expect.stringMatching(/^status /),
        receivedAt: expect.any(Date),
      },
    ]);
    expect(await devices().countDocuments()).toBe(0);
  });

  it('AT9: an extra firmware field is accepted and not stored', async () => {
    await send('dev-1', { ...seq5, firmware: '1.2' });

    const state = await stateOf('dev-1');
    expect(state).not.toHaveProperty('firmware');
    expect(state).toEqual({ deviceId: 'dev-1', ...seq5 });
    expect(await rejects().countDocuments()).toBe(0);
  });

  it('AT10: two devices get independent documents', async () => {
    await send('dev-a', seq4);
    await send('dev-b', seq5);
    await send('dev-a', seq6);

    expect(await devices().countDocuments()).toBe(2);
    expect(await stateOf('dev-a')).toEqual({ deviceId: 'dev-a', ...seq6 });
    expect(await stateOf('dev-b')).toEqual({ deviceId: 'dev-b', ...seq5 });
  });

  it('takes the device ID from the topic, never the payload', async () => {
    await send('dev-1', { ...seq5, deviceId: 'spoofed' });

    expect(await devices().countDocuments()).toBe(1);
    expect(await stateOf('dev-1')).toEqual({ deviceId: 'dev-1', ...seq5 });
  });

  it.each([
    'devices//heartbeat',
    'devices/a/b/heartbeat',
    'sensors/a/heartbeat',
    'devices/a/status',
  ])('rejects topic %s with a reason naming deviceId', async (topic) => {
    const raw = JSON.stringify(seq5);

    await handle(topic, Buffer.from(raw));

    expect(await allRejects()).toEqual([
      {
        topic,
        payload: raw,
        reason: expect.stringMatching(/^deviceId/),
        receivedAt: expect.any(Date),
      },
    ]);
    expect(await devices().countDocuments()).toBe(0);
  });

  it('logs a Mongo error on a valid message at error level without creating a reject', async () => {
    const err = new MongoNetworkError('connection lost');
    const failing = createHeartbeatHandler({
      devices: { applyHeartbeat: () => Promise.reject(err) },
      rejects: createRejectStore(db),
      logger,
    });

    await expect(
      failing(topicFor('dev-1'), Buffer.from(JSON.stringify(seq5))),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topic: 'devices/dev-1/heartbeat', err }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await rejects().countDocuments()).toBe(0);
  });

  it('does not throw when storing a reject fails, and logs the topic and reason', async () => {
    const err = new MongoNetworkError('connection lost');
    const failing = createHeartbeatHandler({
      devices: createDeviceStore(db),
      rejects: { insert: () => Promise.reject(err) },
      logger,
    });

    await expect(
      failing(
        topicFor('dev-1'),
        Buffer.from(JSON.stringify({ ...seq5, battery: 150 })),
      ),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        topic: 'devices/dev-1/heartbeat',
        reason: expect.stringMatching(/^battery /),
        err,
      }),
    );
  });
});
