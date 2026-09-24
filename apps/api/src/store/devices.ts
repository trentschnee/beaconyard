import type { Db } from 'mongodb';
import type { DeviceState, Heartbeat } from '@beaconyard/contracts';

export interface DeviceStore {
  ensureIndexes(): Promise<void>;
  applyHeartbeat(deviceId: string, hb: Heartbeat): Promise<void>;
}

export function createDeviceStore(db: Db): DeviceStore {
  const devices = db.collection<DeviceState>('devices');

  return {
    async ensureIndexes() {
      await devices.createIndex({ deviceId: 1 }, { unique: true });
    },

    // seq alone decides which heartbeat wins (decisions/001-message-id.md).
    //
    // The seq check lives in the update pipeline, not the filter. With
    // `seq: { $lt: hb.seq }` in the filter, every stale or duplicate heartbeat
    // would miss, the upsert would try to insert a second doc for the device,
    // and the unique index would throw E11000. Devices replay their buffer on
    // reconnect, so duplicates are normal traffic and shouldn't go through an
    // error path. Filtering on deviceId alone means a duplicate just matches
    // the doc and the $cond keeps what's stored.
    //
    // Two heartbeats for a new device can both try to insert. Mongo retries
    // the losing upsert on the server because the filter is a single equality
    // on the unique index key and the update never touches deviceId, so the
    // retry runs the $cond against the winner's doc.
    //
    // Every $cond in one $set stage reads the pre-update doc, so the four
    // fields always move together. A new device starts as { deviceId } from
    // the filter and its missing seq counts as 0.
    async applyHeartbeat(deviceId, hb) {
      const isNewer = { $lt: [{ $ifNull: ['$seq', 0] }, hb.seq] };
      const pick = (field: keyof Heartbeat) => ({
        $cond: [isNewer, { $literal: hb[field] }, `$${field}`],
      });

      await devices.updateOne(
        { deviceId },
        [
          {
            $set: {
              seq: pick('seq'),
              ts: pick('ts'),
              battery: pick('battery'),
              status: pick('status'),
            },
          },
        ],
        { upsert: true },
      );
    },
  };
}
