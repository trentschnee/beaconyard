import { parseHeartbeat } from '@beaconyard/contracts';
import type { Logger } from '../../logger';
import type { DeviceStore } from '../../store/devices';
import type { EventStore } from '../../store/events';
import type { RejectStore } from '../../store/rejects';

export const HEARTBEAT_TOPIC = 'devices/+/heartbeat';

// `+` also matches an empty level, so devices//heartbeat can still arrive
const TOPIC_PATTERN = /^devices\/([^/]+)\/heartbeat$/;

export interface HeartbeatDeps {
  events: Pick<EventStore, 'record'>;
  devices: Pick<DeviceStore, 'applyHeartbeat'>;
  rejects: Pick<RejectStore, 'insert'>;
  logger: Logger;
}

export type HeartbeatHandler = (
  topic: string,
  payload: Buffer | string,
) => Promise<void>;

export function createHeartbeatHandler({
  events,
  devices,
  rejects,
  logger,
}: HeartbeatDeps): HeartbeatHandler {
  async function reject(topic: string, payload: string, reason: string) {
    logger.warn('heartbeat rejected', { topic, reason });
    try {
      await rejects.insert({ topic, payload, reason, receivedAt: new Date() });
    } catch (err) {
      logger.error('failed to store rejected heartbeat', {
        topic,
        reason,
        err,
      });
    }
  }

  // never throws: a bad message or a Mongo failure is logged and dropped so
  // the mqtt client keeps going
  return async (topic, payload) => {
    try {
      const raw =
        typeof payload === 'string' ? payload : payload.toString('utf8');

      const deviceId = TOPIC_PATTERN.exec(topic)?.[1];
      if (!deviceId) {
        await reject(
          topic,
          raw,
          'deviceId: topic must be devices/<id>/heartbeat',
        );
        return;
      }

      const parsed = parseHeartbeat(raw);
      if (!parsed.ok) {
        await reject(topic, raw, parsed.reason);
        return;
      }

      // Event first, so state never shows a seq that history doesn't have. If
      // the event write throws, state is left alone. Stale and duplicate seqs
      // are a no-op in both stores, not an error.
      await events.record(deviceId, [parsed.value]);
      await devices.applyHeartbeat(deviceId, parsed.value);
    } catch (err) {
      logger.error('heartbeat handling failed', { topic, err });
    }
  };
}
