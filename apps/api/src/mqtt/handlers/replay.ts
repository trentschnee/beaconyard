import {
  parseReplayBatch,
  type DeviceState,
  type Heartbeat,
  type ReplayEntryError,
} from '@beaconyard/contracts';
import type { Logger } from '../../logger';
import type { DeviceStore } from '../../store/devices';
import type { EventStore } from '../../store/events';
import type { RejectStore } from '../../store/rejects';

export const REPLAY_TOPIC = 'devices/+/replay';

// `+` also matches an empty level, so devices//replay can still arrive
const TOPIC_PATTERN = /^devices\/([^/]+)\/replay$/;

export interface ReplayDeps {
  events: Pick<EventStore, 'record'>;
  devices: Pick<DeviceStore, 'applyHeartbeat'>;
  rejects: Pick<RejectStore, 'insert' | 'insertMany'>;
  logger: Logger;
  // called after a write that changed the device's state. Must not block;
  // a throw is logged and ingest carries on.
  onDeviceChanged: (state: DeviceState) => void;
}

export type ReplayHandler = (
  topic: string,
  payload: Buffer | string,
) => Promise<void>;

// First valid copy of each seq wins. Invalid entries never get here, so a bad
// first copy doesn't shadow a good second one.
function firstPerSeq(heartbeats: readonly Heartbeat[]): Heartbeat[] {
  const bySeq = new Map<number, Heartbeat>();
  for (const hb of heartbeats) {
    if (!bySeq.has(hb.seq)) {
      bySeq.set(hb.seq, hb);
    }
  }
  return [...bySeq.values()];
}

function highestSeq(heartbeats: readonly Heartbeat[]): Heartbeat {
  return heartbeats.reduce((top, hb) => (hb.seq > top.seq ? hb : top));
}

export function createReplayHandler({
  events,
  devices,
  rejects,
  logger,
  onDeviceChanged,
}: ReplayDeps): ReplayHandler {
  async function reject(topic: string, payload: string, reason: string) {
    logger.warn('replay rejected', { topic, reason });
    try {
      await rejects.insert({ topic, payload, reason, receivedAt: new Date() });
    } catch (err) {
      logger.error('failed to store rejected replay', { topic, reason, err });
    }
  }

  async function rejectEntries(topic: string, errors: ReplayEntryError[]) {
    if (errors.length === 0) {
      return;
    }
    for (const { reason } of errors) {
      logger.warn('replay entry rejected', { topic, reason });
    }
    const receivedAt = new Date();
    try {
      await rejects.insertMany(
        errors.map(({ payload, reason }) => ({
          topic,
          payload,
          reason,
          receivedAt,
        })),
      );
    } catch (err) {
      logger.error('failed to store rejected replay entries', {
        topic,
        reasons: errors.map((e) => e.reason),
        err,
      });
    }
  }

  // by now the batch is stored, so a broadcast failure only gets logged
  function notify(topic: string, state: DeviceState) {
    try {
      onDeviceChanged(state);
    } catch (err) {
      logger.error('device broadcast failed', {
        topic,
        deviceId: state.deviceId,
        err,
      });
    }
  }

  // never throws: a bad batch or a Mongo failure is logged and dropped so the
  // mqtt client keeps going
  return async (topic, payload) => {
    try {
      const raw =
        typeof payload === 'string' ? payload : payload.toString('utf8');

      const deviceId = TOPIC_PATTERN.exec(topic)?.[1];
      if (!deviceId) {
        await reject(topic, raw, 'deviceId: topic must be devices/<id>/replay');
        return;
      }

      const parsed = parseReplayBatch(raw);
      if (!parsed.ok) {
        await reject(topic, raw, parsed.reason);
        return;
      }

      // before the valid writes, so a Mongo failure there can't lose these
      await rejectEntries(topic, parsed.value.errors);

      const unique = firstPerSeq(parsed.value.heartbeats);
      if (unique.length === 0) {
        return;
      }

      // Events first, so state never shows a seq that history doesn't have.
      // Applying only the highest seq leaves the same state as applying every
      // entry in turn, since the highest seq wins either way. Duplicates and
      // stale seqs are a no-op in both stores, not an error. One state write
      // per batch also means at most one broadcast per batch.
      await events.record(deviceId, unique);
      const changed = await devices.applyHeartbeat(
        deviceId,
        highestSeq(unique),
      );
      if (changed) {
        notify(topic, changed);
      }
    } catch (err) {
      logger.error('replay handling failed', { topic, err });
    }
  };
}
