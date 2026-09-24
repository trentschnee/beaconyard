import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import type { Logger } from '../logger';

const SUBSCRIBE_QOS = 1;

export type ConnectFn = (url: string, opts: IClientOptions) => MqttClient;

export type MessageHandler = (topic: string, payload: Buffer) => Promise<void>;

// subscription filter (e.g. devices/+/heartbeat) -> handler for its messages
export type TopicHandlers = Record<string, MessageHandler>;

export interface MqttOptions {
  url: string;
  clientId: string;
}

// MQTT filter match, `+` only since that's all we subscribe with. `+` is
// exactly one level and may be empty, so devices//replay still reaches the
// replay handler and gets rejected there instead of vanishing here.
function matchesFilter(filter: string, topic: string): boolean {
  const filterLevels = filter.split('/');
  const topicLevels = topic.split('/');
  return (
    filterLevels.length === topicLevels.length &&
    filterLevels.every((level, i) => level === '+' || level === topicLevels[i])
  );
}

// Persistent session with a fixed client ID, so the broker queues QoS 1
// messages while the api is down and hands them over on reconnect. Assumes a
// single api instance: a second client with the same ID kicks the first off.
export function startMqtt(
  { url, clientId }: MqttOptions,
  logger: Logger,
  handlers: TopicHandlers,
  connectFn: ConnectFn = connect,
): MqttClient {
  const filters = Object.keys(handlers);

  // we subscribe on every connect below, so keep mqtt.js from resubscribing too
  const client = connectFn(url, { clientId, clean: false, resubscribe: false });

  // 'connect' fires on every successful CONNACK, reconnects included
  client.on('connect', () => {
    logger.info('mqtt connected', { url, clientId });
    for (const filter of filters) {
      // mqtt.js turns a refused SUBACK (reason code >= 0x80) into err as well
      client.subscribe(filter, { qos: SUBSCRIBE_QOS }, (err, granted) => {
        if (err) {
          logger.error('mqtt subscribe failed', { topic: filter, err });
          return;
        }
        for (const grant of granted ?? []) {
          if (grant.qos < SUBSCRIBE_QOS) {
            logger.warn('mqtt subscribe granted lower qos', {
              topic: grant.topic,
              requestedQos: SUBSCRIBE_QOS,
              grantedQos: grant.qos,
            });
          }
        }
      });
    }
  });
  client.on('reconnect', () => logger.warn('mqtt reconnecting', { url }));
  client.on('error', (err) => logger.error('mqtt error', { url, err }));

  // handlers never reject, they log their own failures
  client.on('message', (topic, payload) => {
    const filter = filters.find((f) => matchesFilter(f, topic));
    if (!filter) {
      // the broker only sends what we subscribed to, so this is a bug
      logger.warn('mqtt message on a topic with no handler', { topic });
      return;
    }
    void handlers[filter](topic, payload);
  });

  return client;
}
