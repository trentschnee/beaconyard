import type { Db } from 'mongodb';
import type { EventRecord, Heartbeat } from '@beaconyard/contracts';

export interface EventStore {
  ensureIndexes(): Promise<void>;
  record(deviceId: string, heartbeats: readonly Heartbeat[]): Promise<void>;
}

export function createEventStore(db: Db): EventStore {
  const events = db.collection<EventRecord>('events');

  return {
    async ensureIndexes() {
      await events.createIndex({ deviceId: 1, seq: 1 }, { unique: true });
    },

    // One event per deviceId + seq, first copy wins (decisions/001-message-id.md).
    //
    // An upsert with $setOnInsert instead of insertOne: a duplicate matches the
    // stored event and changes nothing, so replays never hit E11000. The unique
    // index is still what guarantees one event per seq. When two upserts race on
    // a new seq, Mongo retries the loser on the server because the filter is
    // exactly the unique key and the update doesn't touch it, and the retry
    // then matches the winner's doc.
    //
    // ordered so a seq repeated in the input keeps its first copy
    async record(deviceId, heartbeats) {
      if (heartbeats.length === 0) {
        return;
      }
      await events.bulkWrite(
        heartbeats.map(({ seq, ts, battery, status }) => ({
          updateOne: {
            filter: { deviceId, seq },
            update: { $setOnInsert: { ts, battery, status } },
            upsert: true,
          },
        })),
        { ordered: true },
      );
    },
  };
}
