import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { DashboardMessage, DeviceState } from '@beaconyard/contracts';
import {
  DASHBOARD_SOCKET_FACTORY,
  RECONNECT_DELAY_MS,
  type DashboardSocket,
} from './dashboard-connection';
import { DevicesPage } from './devices-page';

// stands in for the browser WebSocket; the test plays the api's side
class FakeSocket extends EventTarget implements DashboardSocket {
  readonly close = jest.fn();

  constructor(readonly url: string) {
    super();
  }

  receive(message: DashboardMessage | string) {
    const data =
      typeof message === 'string' ? message : JSON.stringify(message);
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  // the api went away, or never answered
  drop() {
    this.dispatchEvent(new Event('close'));
  }
}

const dev = (
  deviceId: string,
  seq: number,
  extra: Partial<DeviceState> = {},
): DeviceState => ({
  deviceId,
  seq,
  ts: '2026-09-24T10:00:00Z',
  battery: 50,
  status: 'ok',
  ...extra,
});

// built from Date's local getters, independent of DatePipe
function localTime(ts: string) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

let sockets: FakeSocket[];
let fixture: ComponentFixture<DevicesPage>;

beforeEach(() => {
  sockets = [];
  TestBed.configureTestingModule({
    imports: [DevicesPage],
    providers: [
      {
        provide: DASHBOARD_SOCKET_FACTORY,
        useValue: (url: string) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      },
    ],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

function render() {
  fixture = TestBed.createComponent(DevicesPage);
  fixture.detectChanges();
}

function page(): HTMLElement {
  // zoneless: run change detection by hand so fake timers can't stall it
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const statusText = () =>
  page().querySelector('[role="status"]')?.textContent?.trim();

const rows = () =>
  Array.from(page().querySelectorAll('tbody tr'), (tr) =>
    Array.from(tr.querySelectorAll('td'), (td) => td.textContent?.trim()),
  );

const deviceIds = () => rows().map((cells) => cells[0]);

describe('DevicesPage', () => {
  it('S04-AT9: shows one row per device, sorted by ID, and the connection state', () => {
    render();
    expect(statusText()).toBe('connecting');
    expect(sockets.map((s) => s.url)).toEqual(['ws://localhost/ws/devices']);

    // offsets on either side of UTC, so at most one can match the local zone
    // and the rest prove the time is converted
    sockets[0].receive({
      type: 'snapshot',
      devices: [
        dev('dev-c', 3, { ts: '2026-09-24T23:30:00-05:00', battery: 7 }),
        dev('dev-a', 9, {
          ts: '2026-09-23T10:00:00.123+02:00',
          battery: 100,
          status: 'fault',
        }),
        dev('dev-b', 1, { ts: '2026-09-24T06:05:09Z', status: 'warning' }),
      ],
    });

    expect(rows()).toEqual([
      ['dev-a', 'fault', '100%', localTime('2026-09-23T10:00:00.123+02:00')],
      ['dev-b', 'warning', '50%', localTime('2026-09-24T06:05:09Z')],
      ['dev-c', 'ok', '7%', localTime('2026-09-24T23:30:00-05:00')],
    ]);
    expect(statusText()).toBe('live');
  });

  it('S04-AT10: after the connection closes it shows reconnecting, reconnects after 2 s and applies the new snapshot', () => {
    jest.useFakeTimers();
    render();
    sockets[0].receive({
      type: 'snapshot',
      devices: [dev('a', 5), dev('b', 1)],
    });
    expect(statusText()).toBe('live');

    sockets[0].drop();

    expect(statusText()).toBe('reconnecting');
    // the last known rows stay up while it's away
    expect(deviceIds()).toEqual(['a', 'b']);

    jest.advanceTimersByTime(RECONNECT_DELAY_MS - 1);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toBe(sockets[0].url);
    expect(statusText()).toBe('reconnecting');

    sockets[1].receive({
      type: 'snapshot',
      devices: [dev('a', 2, { battery: 11 }), dev('c', 1)],
    });

    // b is gone, and a takes the snapshot's state even though its seq is lower
    expect(rows()).toEqual([
      ['a', 'ok', '11%', localTime(dev('a', 2).ts)],
      ['c', 'ok', '50%', localTime(dev('c', 1).ts)],
    ]);
    expect(statusText()).toBe('live');
  });

  it('S04-AT10: keeps retrying every 2 s while the api is down', () => {
    jest.useFakeTimers();
    render();
    sockets[0].receive({ type: 'snapshot', devices: [dev('a', 1)] });
    sockets[0].drop();

    for (let attempt = 1; attempt <= 3; attempt++) {
      jest.advanceTimersByTime(RECONNECT_DELAY_MS);
      expect(sockets).toHaveLength(attempt + 1);
      // refused before any snapshot
      sockets[attempt].drop();
      expect(statusText()).toBe('reconnecting');
    }

    jest.advanceTimersByTime(RECONNECT_DELAY_MS);
    sockets[4].receive({ type: 'snapshot', devices: [dev('a', 2)] });
    expect(statusText()).toBe('live');
  });

  it('stays on connecting and retries when the first attempt fails', () => {
    jest.useFakeTimers();
    render();

    sockets[0].drop();
    expect(statusText()).toBe('connecting');

    jest.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(sockets).toHaveLength(2);
    sockets[1].receive({ type: 'snapshot', devices: [] });
    expect(statusText()).toBe('live');
    expect(rows()).toEqual([['No devices yet']]);
  });

  it('applies device updates by seq', () => {
    render();
    sockets[0].receive({ type: 'snapshot', devices: [dev('b', 5)] });

    sockets[0].receive({
      type: 'device',
      device: dev('b', 6, { battery: 20 }),
    });
    sockets[0].receive({
      type: 'device',
      device: dev('b', 4, { battery: 90 }),
    });
    sockets[0].receive({ type: 'device', device: dev('a', 1) });

    expect(rows().map((cells) => cells.slice(0, 3))).toEqual([
      ['a', 'ok', '50%'],
      ['b', 'ok', '20%'],
    ]);
  });

  it('logs a message it cannot read and keeps going', () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {
      // keep test output quiet
    });
    render();
    sockets[0].receive({ type: 'snapshot', devices: [dev('a', 1)] });

    sockets[0].receive('{"type": "snap');
    sockets[0].receive('null');
    sockets[0].receive(JSON.stringify({ type: 'alert' }));
    sockets[0].receive({ type: 'device', device: dev('b', 1) });

    expect(logged).toHaveBeenCalledTimes(3);
    expect(deviceIds()).toEqual(['a', 'b']);
    expect(statusText()).toBe('live');
  });

  it('closes the socket and stops retrying when the page is destroyed', () => {
    jest.useFakeTimers();
    render();
    sockets[0].receive({ type: 'snapshot', devices: [] });

    fixture.destroy();
    expect(sockets[0].close).toHaveBeenCalled();

    sockets[0].drop();
    jest.advanceTimersByTime(RECONNECT_DELAY_MS * 3);
    expect(sockets).toHaveLength(1);
  });
});
