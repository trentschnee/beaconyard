import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import type { Logger } from '../logger';
import { HEARTBEAT_TOPIC, type HeartbeatHandler } from './handlers/heartbeat';

const HEARTBEAT_QOS = 1;

export type ConnectFn = (url: string, opts: IClientOptions) => MqttClient;

// Clean session, so anything published while the api is down is lost.
// Known gap, revisit in spec 02.
export function startMqtt(
  url: string,
  logger: Logger,
  onHeartbeat: HeartbeatHandler,
  connectFn: ConnectFn = connect,
): MqttClient {
  // we subscribe on every connect below, so keep mqtt.js from resubscribing too
  const client = connectFn(url, { resubscribe: false });

  // 'connect' fires on every successful CONNACK, reconnects included
  client.on('connect', () => {
    logger.info('mqtt connected', { url });
    // mqtt.js turns a refused SUBACK (reason code >= 0x80) into err as well
    client.subscribe(
      HEARTBEAT_TOPIC,
      { qos: HEARTBEAT_QOS },
      (err, granted) => {
        if (err) {
          logger.error('mqtt subscribe failed', {
            topic: HEARTBEAT_TOPIC,
            err,
          });
          return;
        }
        for (const grant of granted ?? []) {
          if (grant.qos < HEARTBEAT_QOS) {
            logger.warn('mqtt subscribe granted lower qos', {
              topic: grant.topic,
              requestedQos: HEARTBEAT_QOS,
              grantedQos: grant.qos,
            });
          }
        }
      },
    );
  });
  client.on('reconnect', () => logger.warn('mqtt reconnecting', { url }));
  client.on('error', (err) => logger.error('mqtt error', { url, err }));

  // the handler never rejects, it logs its own failures
  client.on('message', (topic, payload) => {
    void onHeartbeat(topic, payload);
  });

  return client;
}
