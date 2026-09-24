import type { Db } from 'mongodb';
import type { AlertState, LowBatteryState } from '@beaconyard/contracts';

export interface AlertStateStore {
  ensureIndexes(): Promise<void>;
  // Applies one state to the device's low-battery flag. next is where the
  // battery says the flag should go, or null to leave it as it is. Resolves
  // true only for the one call that moved the device from armed to alerted.
  applyLowBattery(
    deviceId: string,
    seq: number,
    next: LowBatteryState | null,
  ): Promise<boolean>;
}

export function createAlertStateStore(db: Db): AlertStateStore {
  const alertStates = db.collection<AlertState>('alertStates');

  return {
    async ensureIndexes() {
      await alertStates.createIndex({ deviceId: 1 }, { unique: true });
    },

    // Same shape as the devices write in store/devices.ts: filter on deviceId
    // alone, seq check inside the pipeline. A stale or duplicate seq matches
    // the stored doc and writes back what's there, so it never misses into an
    // upsert that trips the unique index. Every $cond reads the pre-update
    // doc. A new device starts as { deviceId } from the filter, its missing
    // seq counts as 0 and its missing flag as armed.
    //
    // Every newer seq moves seq forward, flag change or not. Otherwise a late
    // low state could still land behind a newer healthy one.
    //
    // Whether this call flipped the device comes from the pre-image this same
    // findAndModify returns, not a second read. Writes to one doc serialize,
    // so of two racing low states only the first sees armed; the second sees
    // the first one's alerted. null means this call inserted the doc. When two
    // first states race to insert, Mongo retries the loser on the server
    // (single equality filter on the unique key, update never touches
    // deviceId), and the retry's pre-image is the winner's doc, not null.
    async applyLowBattery(deviceId, seq, next) {
      const isNewer = { $lt: [{ $ifNull: ['$seq', 0] }, seq] };

      const before = await alertStates.findOneAndUpdate(
        { deviceId },
        [
          {
            $set: {
              seq: { $cond: [isNewer, { $literal: seq }, '$seq'] },
              lowBattery: {
                $cond: [
                  isNewer,
                  next
                    ? { $literal: next }
                    : { $ifNull: ['$lowBattery', 'armed'] },
                  '$lowBattery',
                ],
              },
            },
          },
        ],
        { upsert: true, returnDocument: 'before' },
      );

      const wasArmed =
        before === null || (before.seq < seq && before.lowBattery === 'armed');
      return next === 'alerted' && wasArmed;
    },
  };
}
