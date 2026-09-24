import type { Db } from 'mongodb';
import type { RejectedMessage } from '@beaconyard/contracts';

export interface RejectStore {
  insert(reject: RejectedMessage): Promise<void>;
  insertMany(rejects: readonly RejectedMessage[]): Promise<void>;
}

export function createRejectStore(db: Db): RejectStore {
  const rejects = db.collection<RejectedMessage>('rejects');
  return {
    async insert(reject) {
      // copy so the driver's _id doesn't land on the caller's object
      await rejects.insertOne({ ...reject });
    },

    async insertMany(batch) {
      // the driver refuses an empty insertMany
      if (batch.length === 0) {
        return;
      }
      await rejects.insertMany(batch.map((reject) => ({ ...reject })));
    },
  };
}
