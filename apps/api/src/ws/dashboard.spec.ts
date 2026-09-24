import type { DashboardMessage, DeviceState } from '@beaconyard/contracts';
import type { Logger } from '../logger';
import {
  createDashboardHub,
  type DashboardHub,
  type DashboardSocket,
} from './dashboard';

const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements DashboardSocket {
  readyState = OPEN;
  readonly received: DashboardMessage[] = [];
  private readonly closeListeners: (() => void)[] = [];

  send = jest.fn((data: string) => {
    this.received.push(JSON.parse(data));
  });
  close = jest.fn(() => this.disconnect());
  terminate = jest.fn(() => this.disconnect());

  on(_event: 'close', listener: () => void) {
    this.closeListeners.push(listener);
    return this;
  }

  // what ws does when the peer goes away: state first, close event after
  disconnect() {
    this.readyState = CLOSED;
    this.closeListeners.forEach((listener) => listener());
  }
}

const dev = (deviceId: string, seq: number): DeviceState => ({
  deviceId,
  seq,
  ts: `2026-09-24T10:00:${String(seq).padStart(2, '0')}Z`,
  battery: 50 + seq,
  status: 'ok',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let logger: jest.Mocked<Logger>;
let list: jest.Mock<Promise<DeviceState[]>, []>;
let hub: DashboardHub;

beforeEach(() => {
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  list = jest.fn(() => Promise.resolve([dev('a', 1), dev('b', 2)]));
  hub = createDashboardHub({ devices: { list }, logger });
});

async function connected() {
  const socket = new FakeSocket();
  await hub.connect(socket);
  return socket;
}

describe('dashboard hub', () => {
  it('sends the snapshot first, then each published change', async () => {
    const socket = await connected();
    hub.publish(dev('a', 3));

    expect(socket.received).toEqual([
      { type: 'snapshot', devices: [dev('a', 1), dev('b', 2)] },
      { type: 'device', device: dev('a', 3) },
    ]);
  });

  it('S04-AT2: a change published during the snapshot read arrives after the snapshot', async () => {
    const read = deferred<DeviceState[]>();
    list.mockReturnValueOnce(read.promise);
    const socket = new FakeSocket();

    const connecting = hub.connect(socket);
    hub.publish(dev('c', 7));
    expect(socket.received).toEqual([]);

    read.resolve([dev('a', 1)]);
    await connecting;

    expect(socket.received).toEqual([
      { type: 'snapshot', devices: [dev('a', 1)] },
      { type: 'device', device: dev('c', 7) },
    ]);
  });

  it('S04-AT6: a broken and a disconnected client do not stop an open one', async () => {
    const open = await connected();
    const broken = await connected();
    const gone = await connected();
    const err = new Error('socket exploded');
    broken.send.mockImplementation(() => {
      throw err;
    });
    // disconnected, and ws hasn't fired its close event yet
    gone.readyState = CLOSED;
    gone.send.mockClear();

    hub.publish(dev('a', 3));

    expect(open.received.at(-1)).toEqual({
      type: 'device',
      device: dev('a', 3),
    });
    expect(gone.send).not.toHaveBeenCalled();
    expect(broken.terminate).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ err }),
    );

    // the broken one is gone for good, the open one keeps getting updates
    broken.send.mockClear();
    hub.publish(dev('b', 4));

    expect(broken.send).not.toHaveBeenCalled();
    expect(open.received.at(-1)).toEqual({
      type: 'device',
      device: dev('b', 4),
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('forgets a client once it closes', async () => {
    const socket = await connected();
    socket.disconnect();
    socket.send.mockClear();

    hub.publish(dev('a', 3));

    expect(socket.send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips the snapshot for a client that disconnects during the read', async () => {
    const read = deferred<DeviceState[]>();
    list.mockReturnValueOnce(read.promise);
    const socket = new FakeSocket();

    const connecting = hub.connect(socket);
    socket.disconnect();
    read.resolve([dev('a', 1)]);
    await connecting;
    hub.publish(dev('a', 2));

    expect(socket.send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('closes with 1011 and sends nothing when the snapshot read fails', async () => {
    const err = new Error('mongo down');
    list.mockRejectedValueOnce(err);
    const socket = new FakeSocket();

    await hub.connect(socket);
    hub.publish(dev('a', 2));

    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1011, expect.any(String));
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ err }),
    );
  });

  it('sends every client the same update', async () => {
    const first = await connected();
    const second = await connected();

    hub.publish(dev('b', 5));

    for (const socket of [first, second]) {
      expect(socket.received).toEqual([
        { type: 'snapshot', devices: [dev('a', 1), dev('b', 2)] },
        { type: 'device', device: dev('b', 5) },
      ]);
    }
  });
});
