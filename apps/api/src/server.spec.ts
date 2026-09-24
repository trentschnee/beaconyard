import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type {
  DashboardMessage,
  DeviceState,
  EventRecord,
  Heartbeat,
  RejectedMessage,
} from '@beaconyard/contracts';
import { loadConfig } from './config';
import type { Logger } from './logger';
import {
  createHeartbeatHandler,
  type HeartbeatHandler,
} from './mqtt/handlers/heartbeat';
import {
  createReplayHandler,
  type ReplayHandler,
} from './mqtt/handlers/replay';
import { createServer, DASHBOARD_PATH } from './server';
import { createDeviceStore } from './store/devices';
import { createEventStore } from './store/events';
import { createRejectStore } from './store/rejects';
import { createDashboardHub } from './ws/dashboard';

// spec 04 AT3: a change reaches the browser within 1 s
const UPDATE_WITHIN_MS = 1_000;

let mongod: MongoMemoryServer;
let mongo: MongoClient;
let db: Db;
let logger: jest.Mocked<Logger>;
let app: FastifyInstance | undefined;
let live: HeartbeatHandler;
let replay: ReplayHandler;
const openClients: WebSocket[] = [];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // same Jest workaround as heartbeat.spec.ts: hand the driver its os adapter
  mongo = await MongoClient.connect(mongod.getUri(), {
    runtimeAdapters: { os },
  });
  db = mongo.db('server-spec');
  await createDeviceStore(db).ensureIndexes();
  await createEventStore(db).ensureIndexes();
}, 30_000);

afterAll(async () => {
  await mongo?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all(
    ['devices', 'events', 'rejects'].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

afterEach(async () => {
  openClients.splice(0).forEach((ws) => ws.close());
  await app?.close();
  app = undefined;
});

// wired the way main.ts does it
async function startApi(env: NodeJS.ProcessEnv): Promise<number> {
  const config = loadConfig(env);
  const devices = createDeviceStore(db);
  const dashboard = config.dashboardEnabled
    ? createDashboardHub({ devices, logger })
    : undefined;
  const deps = {
    events: createEventStore(db),
    devices,
    rejects: createRejectStore(db),
    logger,
    onDeviceChanged: dashboard ? dashboard.publish : () => undefined,
  };
  live = createHeartbeatHandler(deps);
  replay = createReplayHandler(deps);

  app = await createServer({ logger, dashboard });
  await app.listen({ host: config.httpHost, port: 0 });
  return (app.server.address() as AddressInfo).port;
}

const startDashboard = () => startApi({ DASHBOARD_ENABLED: 'true' });

function hb(seq: number, battery = 40 + seq): Heartbeat {
  return {
    seq,
    ts: `2026-09-24T10:00:${String(seq).padStart(2, '0')}Z`,
    battery,
    status: 'ok',
  };
}

const sendLive = (deviceId: string, body: object) =>
  live(`devices/${deviceId}/heartbeat`, Buffer.from(JSON.stringify(body)));

const sendReplay = (deviceId: string, entries: object[]) =>
  replay(`devices/${deviceId}/replay`, Buffer.from(JSON.stringify(entries)));

const state = (deviceId: string, body: Heartbeat): DeviceState => ({
  deviceId,
  ...body,
});

interface Client {
  ws: WebSocket;
  // the next message, in arrival order
  next(timeoutMs?: number): Promise<DashboardMessage>;
}

// Node 22's built-in WebSocket client, over a real socket
async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${DASHBOARD_PATH}`);
  openClients.push(ws);
  const queue: DashboardMessage[] = [];
  const waiters: ((message: DashboardMessage) => void)[] = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as DashboardMessage;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('connect failed')), {
      once: true,
    });
  });

  function next(timeoutMs = UPDATE_WITHIN_MS) {
    const queued = queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise<DashboardMessage>((resolve, reject) => {
      const waiter = (message: DashboardMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`no message within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return { ws, next };
}

function closed(ws: WebSocket) {
  return new Promise<void>((resolve) =>
    ws.addEventListener('close', () => resolve(), { once: true }),
  );
}

// A raw upgrade request, so the test sees the status the server answers with
// rather than just "the client failed to connect".
function tryUpgrade(port: number) {
  return new Promise<{ status?: number; upgraded: boolean }>(
    (resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: DASHBOARD_PATH,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      });
      req.on('response', (res) => {
        res.resume();
        resolve({ status: res.statusCode, upgraded: false });
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode, upgraded: true });
      });
      req.on('error', reject);
      req.end();
    },
  );
}

describe('api http server', () => {
  it('S04-AT1: with the flag unset, a request and an upgrade to /ws/devices both get 404', async () => {
    const port = await startApi({});

    const res = await fetch(`http://127.0.0.1:${port}${DASHBOARD_PATH}`);
    await res.body?.cancel();
    expect(res.status).toBe(404);

    expect(await tryUpgrade(port)).toEqual({ status: 404, upgraded: false });
  });

  it('upgrades /ws/devices with the flag on (the AT1 check can tell the difference)', async () => {
    const port = await startDashboard();

    expect(await tryUpgrade(port)).toEqual({ status: 101, upgraded: true });
  });

  it('S04-AT2: a new client first receives a snapshot of every device in Mongo', async () => {
    const port = await startDashboard();
    await sendLive('dev-c', hb(3));
    await sendLive('dev-a', hb(1));
    await sendLive('dev-b', hb(2));
    await sendLive('dev-a', hb(4));

    const client = await connect(port);

    expect(await client.next()).toEqual({
      type: 'snapshot',
      devices: [
        state('dev-a', hb(4)),
        state('dev-b', hb(2)),
        state('dev-c', hb(3)),
      ],
    });
  });

  it('S04-AT3: a heartbeat handled after a client connects reaches it within 1 s', async () => {
    const port = await startDashboard();
    const client = await connect(port);
    expect(await client.next()).toEqual({ type: 'snapshot', devices: [] });

    await sendLive('dev-1', { ...hb(5), firmware: '1.2' });

    expect(await client.next(UPDATE_WITHIN_MS)).toEqual({
      type: 'device',
      device: state('dev-1', hb(5)),
    });
  });

  it('S04-AT4: stale and duplicate heartbeats send nothing', async () => {
    const port = await startDashboard();
    const client = await connect(port);
    await client.next();
    await sendLive('dev-1', hb(5));
    await client.next();

    await sendLive('dev-1', hb(5));
    await sendLive('dev-1', hb(5, 99));
    await sendLive('dev-1', hb(4));
    // Messages arrive in order, so if the next one is this sentinel, none of
    // the three above sent anything. No sleep window needed.
    await sendLive('dev-1', hb(6));

    expect(await client.next()).toEqual({
      type: 'device',
      device: state('dev-1', hb(6)),
    });
  });

  it('S04-AT5: a replay batch that changes state sends exactly one message, with the final state', async () => {
    const port = await startDashboard();
    const client = await connect(port);
    await client.next();
    await sendLive('dev-1', hb(5));
    await client.next();

    // out of order, a repeat of 8 with a different body, and a stale 3
    await sendReplay('dev-1', [
      hb(6),
      hb(8),
      hb(7),
      hb(10),
      hb(9),
      hb(8, 99),
      hb(3),
    ]);
    // sentinel, as in AT4: nothing else from the batch comes before it
    await sendLive('dev-1', hb(11));

    expect(await client.next()).toEqual({
      type: 'device',
      device: state('dev-1', hb(10)),
    });
    expect(await client.next()).toEqual({
      type: 'device',
      device: state('dev-1', hb(11)),
    });
  });

  it('S04-AT6: two clients both receive an update, and one leaving does not affect the other', async () => {
    const port = await startDashboard();
    const a = await connect(port);
    const b = await connect(port);
    await a.next();
    await b.next();

    await sendLive('dev-1', hb(1));
    const update1 = { type: 'device', device: state('dev-1', hb(1)) };
    expect(await a.next()).toEqual(update1);
    expect(await b.next()).toEqual(update1);

    // straight after the close, while the server may still see a open
    const aClosed = closed(a.ws);
    a.ws.close();
    await sendLive('dev-1', hb(2));
    expect(await b.next()).toEqual({
      type: 'device',
      device: state('dev-1', hb(2)),
    });

    // and once the close has gone all the way through
    await aClosed;
    await sendLive('dev-1', hb(3));
    expect(await b.next()).toEqual({
      type: 'device',
      device: state('dev-1', hb(3)),
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
