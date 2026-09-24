import type { Db } from 'mongodb';
import type { RejectedMessage } from '@beaconyard/contracts';

export interface RejectStore {
  insert(reject: RejectedMessage): Promise<void>;
}

export function createRejectStore(db: Db): RejectStore {
  const rejects = db.collection<RejectedMessage>('rejects');
  return {
    async insert(reject) {
      // copy so the driver's _id doesn't land on the caller's object
      await rejects.insertOne({ ...reject });
    },
  };
}
