import { MongoClient } from 'mongodb';
import { connectAsync, type IClientOptions, type MqttClient } from 'mqtt';
import {
  EVAL_CLIENT_ID,
  EVAL_DB,
  INFRA_CHECK_TIMEOUT_MS,
  type EvalConfig,
} from './config.mts';

// A failure the runner expects and explains itself: print the message, no
// stack trace.
export class RunnerError extends Error {}

export interface Infra {
  // publishes the scenarios; no reconnect, so a broker that drops mid-run
  // fails the run instead of stalling it
  mqtt: MqttClient;
  mongo: MongoClient;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function connectBroker(url: string, opts: IClientOptions = {}) {
  // allowRetries=false so a connect timeout rejects. With the default, mqtt.js
  // resolves only on connect or end and this never settles.
  const connecting = connectAsync(
    url,
    { reconnectPeriod: 0, connectTimeout: INFRA_CHECK_TIMEOUT_MS, ...opts },
    false,
  );
  return withTimeout(connecting, INFRA_CHECK_TIMEOUT_MS);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Both checks run at once so a run with both services down still fails
// inside spec 03's 10 s limit.
export async function connectInfra(config: EvalConfig): Promise<Infra> {
  // the driver waits 30 s for a server by default
  const mongo = new MongoClient(config.mongoUrl, {
    serverSelectionTimeoutMS: INFRA_CHECK_TIMEOUT_MS,
  });
  const [broker, db] = await Promise.allSettled([
    connectBroker(config.mqttUrl),
    withTimeout(
      mongo.connect().then(() => mongo.db(EVAL_DB).command({ ping: 1 })),
      INFRA_CHECK_TIMEOUT_MS,
    ),
  ]);
  if (broker.status === 'fulfilled' && db.status === 'fulfilled') {
    return { mqtt: broker.value, mongo };
  }

  const down: string[] = [];
  if (broker.status === 'rejected') {
    down.push(`MQTT broker at ${config.mqttUrl} (${describe(broker.reason)})`);
  } else {
    await broker.value.endAsync();
  }
  if (db.status === 'rejected') {
    down.push(`Mongo at ${config.mongoUrl} (${describe(db.reason)})`);
  }
  await mongo.close();
  throw new RunnerError(
    `Cannot reach ${down.join(' or ')}.\n` +
      'Start the local infra with: docker compose up -d',
  );
}

// A clean-session connect makes the broker drop whatever it kept for this
// client ID (subscriptions and queued QoS 1 messages) from an earlier run.
export async function clearSession(url: string): Promise<void> {
  const client = await connectBroker(url, {
    clientId: EVAL_CLIENT_ID,
    clean: true,
  });
  await client.endAsync();
}
