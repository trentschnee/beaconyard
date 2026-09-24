import {
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import type { DashboardMessage } from '@beaconyard/contracts';
import { DevicesStore } from './devices-store';

export const DASHBOARD_PATH = '/ws/devices';

// spec 04: after a drop, retry every 2 s until it's back
export const RECONNECT_DELAY_MS = 2_000;

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

// The part of the browser WebSocket this uses, so tests can pass a fake.
export interface DashboardSocket {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  addEventListener(type: 'close', listener: () => void): void;
  close(): void;
}

// Only the envelope is checked. The api is the one writing these, from the
// same contracts types.
function isDashboardMessage(value: unknown): value is DashboardMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  return (
    (msg['type'] === 'snapshot' && Array.isArray(msg['devices'])) ||
    (msg['type'] === 'device' &&
      typeof msg['device'] === 'object' &&
      msg['device'] !== null)
  );
}

export const DASHBOARD_SOCKET_FACTORY = new InjectionToken<
  (url: string) => DashboardSocket
>('DASHBOARD_SOCKET_FACTORY', {
  providedIn: 'root',
  factory: () => (url) => new WebSocket(url),
});

// Keeps one live connection to the api's device feed and feeds DevicesStore.
// Provided by the page, so it stops when the page goes away.
@Injectable()
export class DashboardConnection {
  private readonly store = inject(DevicesStore);
  private readonly openSocket = inject(DASHBOARD_SOCKET_FACTORY);
  private readonly document = inject(DOCUMENT);

  private readonly current = signal<ConnectionStatus>('connecting');
  // connecting until the first snapshot, live once one is applied, and
  // reconnecting from a drop until the next snapshot
  readonly status = this.current.asReadonly();

  private socket: DashboardSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  start(): void {
    if (this.socket || this.retry !== undefined || this.stopped) {
      return;
    }
    this.connect();
  }

  private stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    this.retry = undefined;
    const socket = this.openSocket(this.url());
    this.socket = socket;
    socket.addEventListener('message', (event) => this.receive(event.data));
    // the browser always follows an error with close, so this covers both
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      this.socket = null;
      if (this.current() === 'live') {
        this.current.set('reconnecting');
      }
      this.retry = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
  }

  private receive(data: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch (err) {
      console.error('dashboard: unreadable message', { data, err });
      return;
    }
    if (!isDashboardMessage(message)) {
      console.error('dashboard: unknown message', { message });
      return;
    }
    if (message.type === 'snapshot') {
      this.store.applySnapshot(message.devices);
      this.current.set('live');
    } else {
      this.store.applyUpdate(message.device);
    }
  }

  // Resolved against the page rather than handed to WebSocket as-is, since
  // relative WebSocket URLs are only recent in browsers. It still goes to
  // whichever host served the page, which in dev is the Angular dev server
  // and its /ws proxy.
  private url(): string {
    const url = new URL(DASHBOARD_PATH, this.document.baseURI);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }
}
