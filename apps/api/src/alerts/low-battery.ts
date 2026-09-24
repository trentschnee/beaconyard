import type {
  DeviceState,
  LowBatteryAlert,
  LowBatteryState,
} from '@beaconyard/contracts';
import type { Logger } from '../logger';
import type { AlertStateStore } from '../store/alert-states';

export const alertTopic = (deviceId: string) => `alerts/${deviceId}`;

// QoS 1 so the broker acks it. Not retained, or every new subscriber would get
// an alert for an episode that may be long over.
export const ALERT_PUBLISH_OPTIONS = { qos: 1, retain: false } as const;

// the slice of mqtt.js publishAsync the rule needs
export type AlertPublish = (
  topic: string,
  payload: string,
  opts: typeof ALERT_PUBLISH_OPTIONS,
) => Promise<unknown>;

export interface LowBatteryRuleDeps {
  alertStates: Pick<AlertStateStore, 'applyLowBattery'>;
  publish: AlertPublish;
  logger: Logger;
  lowBatteryBelow: number;
  rearmAt: number;
}

export interface LowBatteryRule {
  // never rejects: failures are logged and that alert is dropped
  evaluate(state: DeviceState): Promise<void>;
}

export function createLowBatteryRule({
  alertStates,
  publish,
  logger,
  lowBatteryBelow,
  rearmAt,
}: LowBatteryRuleDeps): LowBatteryRule {
  // between the two thresholds the flag stays where it is
  function nextFor(battery: number): LowBatteryState | null {
    if (battery < lowBatteryBelow) {
      return 'alerted';
    }
    if (battery >= rearmAt) {
      return 'armed';
    }
    return null;
  }

  return {
    async evaluate(state) {
      const { deviceId, seq, ts, battery } = state;

      // The flag is stored before publishing, so a crash or a failed publish
      // costs one alert rather than sending it twice. No retry either way.
      let flipped: boolean;
      try {
        flipped = await alertStates.applyLowBattery(
          deviceId,
          seq,
          nextFor(battery),
        );
      } catch (err) {
        logger.error('low-battery rule failed', { deviceId, seq, err });
        return;
      }
      if (!flipped) {
        return;
      }

      const alert: LowBatteryAlert = {
        type: 'low-battery',
        deviceId,
        seq,
        ts,
        battery,
      };
      try {
        await publish(
          alertTopic(deviceId),
          JSON.stringify(alert),
          ALERT_PUBLISH_OPTIONS,
        );
        logger.info('low-battery alert published', { deviceId, seq, battery });
      } catch (err) {
        logger.error('low-battery alert publish failed', {
          deviceId,
          seq,
          err,
        });
      }
    },
  };
}
