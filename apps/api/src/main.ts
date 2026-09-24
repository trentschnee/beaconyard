import { MongoClient } from 'mongodb';
import { loadConfig } from './config';
import type { Logger } from './logger';
import { startMqtt } from './mqtt/client';
import {
  createHeartbeatHandler,
  HEARTBEAT_TOPIC,
} from './mqtt/handlers/heartbeat';
import { createReplayHandler, REPLAY_TOPIC } from './mqtt/handlers/replay';
import { createDeviceStore } from './store/devices';
import { createEventStore } from './store/events';
import { createRejectStore } from './store/rejects';

const logger: Logger = console;

async function main() {
  const config = loadConfig();

  const mongo = await MongoClient.connect(config.mongoUrl);
  const db = mongo.db(config.mongoDb);
  logger.info('mongo connected', { db: config.mongoDb });

  const devices = createDeviceStore(db);
  const events = createEventStore(db);
  const rejects = createRejectStore(db);
  // before connecting: the broker hands over its queued backlog right after
  // CONNACK, and the events index is what keeps those writes idempotent
  await devices.ensureIndexes();
  await events.ensureIndexes();

  const deps = { events, devices, rejects, logger };
  const mqtt = startMqtt(
    { url: config.mqttUrl, clientId: config.mqttClientId },
    logger,
    {
      [HEARTBEAT_TOPIC]: createHeartbeatHandler(deps),
      [REPLAY_TOPIC]: createReplayHandler(deps),
    },
  );

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    try {
      await mqtt.endAsync();
      await mongo.close();
      process.exit(0);
    } catch (err) {
      logger.error('shutdown failed', { err });
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('api failed to start', { err });
  process.exit(1);
});
