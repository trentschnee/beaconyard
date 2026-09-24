import type { DashboardMessage, DeviceState } from '@beaconyard/contracts';
import type { Logger } from '../logger';
import type { DeviceStore } from '../store/devices';

// same value in ws and the browser WebSocket API
const OPEN = 1;

// "internal error" close code; the browser reconnects and asks again
const CLOSE_INTERNAL_ERROR = 1011;

// The part of a ws socket the hub uses. Typed here rather than imported from
// ws, which isn't one of our dependencies, and so tests can pass a fake.
export interface DashboardSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'close', listener: () => void): unknown;
}

export interface DashboardHub {
  // sends the snapshot, then every update published from now on
  connect(socket: DashboardSocket): Promise<void>;
  // one device message to every connected client
  publish(state: DeviceState): void;
}

export interface DashboardHubDeps {
  devices: Pick<DeviceStore, 'list'>;
  logger: Logger;
}

interface Client {
  socket: DashboardSocket;
  // updates published while this client's snapshot was being read. null once
  // the snapshot has gone out.
  pending: string[] | null;
}

const encode = (message: DashboardMessage) => JSON.stringify(message);

export function createDashboardHub({
  devices,
  logger,
}: DashboardHubDeps): DashboardHub {
  const clients = new Set<Client>();

  // ws.send only queues the frame, so a slow client grows its own buffer and
  // never holds up the others. A send that throws means the client is broken:
  // drop it and let the browser reconnect for a fresh snapshot.
  function deliver(client: Client, data: string): boolean {
    try {
      client.socket.send(data);
      return true;
    } catch (err) {
      logger.error('dashboard send failed', { err });
      clients.delete(client);
      client.socket.terminate();
      return false;
    }
  }

  return {
    // The client is registered before the snapshot read, so nothing published
    // during the read is lost. Those updates wait in pending and go out right
    // after the snapshot. One that's older than the snapshot is harmless: the
    // browser only takes an update with a higher seq than it shows.
    async connect(socket) {
      const client: Client = { socket, pending: [] };
      clients.add(client);
      socket.on('close', () => clients.delete(client));

      let snapshot: DeviceState[];
      try {
        snapshot = await devices.list();
      } catch (err) {
        // never send part of a snapshot
        logger.error('dashboard snapshot failed', { err });
        clients.delete(client);
        socket.close(CLOSE_INTERNAL_ERROR, 'snapshot failed');
        return;
      }

      if (socket.readyState !== OPEN) {
        clients.delete(client);
        return;
      }
      const pending = client.pending ?? [];
      client.pending = null;
      if (!deliver(client, encode({ type: 'snapshot', devices: snapshot }))) {
        return;
      }
      for (const data of pending) {
        if (!deliver(client, data)) {
          return;
        }
      }
    },

    publish(state) {
      const data = encode({ type: 'device', device: state });
      for (const client of clients) {
        // closing or closed: its close event removes it, nothing to report
        if (client.socket.readyState !== OPEN) {
          continue;
        }
        if (client.pending) {
          client.pending.push(data);
          continue;
        }
        deliver(client, data);
      }
    },
  };
}
