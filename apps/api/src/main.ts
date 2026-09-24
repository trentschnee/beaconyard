import { MongoClient } from 'mongodb';
import { loadConfig } from './config';
import type { Logger } from './logger';
import { startMqtt } from './mqtt/client';
import { createHeartbeatHandler } from './mqtt/handlers/heartbeat';
import { createDeviceStore } from './store/devices';
import { createRejectStore } from './store/rejects';

const logger: Logger = console;

async function main() {
  const config = loadConfig();

  const mongo = await MongoClient.connect(config.mongoUrl);
  const db = mongo.db(config.mongoDb);
  logger.info('mongo connected', { db: config.mongoDb });

  const devices = createDeviceStore(db);
  await devices.ensureIndexes();

  const mqtt = startMqtt(
    config.mqttUrl,
    logger,
    createHeartbeatHandler({
      devices,
      rejects: createRejectStore(db),
      logger,
    }),
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
