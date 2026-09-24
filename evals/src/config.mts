import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');

// Fixed by spec 03 and deliberately not read from env, so nothing can point
// the runner or its api at the real beaconyard database.
export const EVAL_DB = 'beaconyard_eval';
export const EVAL_CLIENT_ID = 'beaconyard-eval';
export const COLLECTIONS = ['devices', 'events', 'rejects'] as const;

// spec 03: unreachable infra must exit within 10 s. Each check gets half that
// because pnpm and node startup come out of the same budget.
export const INFRA_CHECK_TIMEOUT_MS = 5_000;
export const MATCH_TIMEOUT_MS = 5_000;
export const SETTLE_MS = 500;
export const POLL_INTERVAL_MS = 100;

export const API_READY_TIMEOUT_MS = 30_000;
export const API_STOP_TIMEOUT_MS = 5_000;
// how long one readiness probe gets to show up before we send the next one
export const PROBE_ATTEMPT_MS = 1_000;
export const PROBE_DEVICE_ID = 'eval-ready';

export const API_MAIN = resolve(REPO_ROOT, 'dist/apps/api/main.js');
export const SCENARIO_DIR = resolve(REPO_ROOT, 'evals/scenarios');

export interface EvalConfig {
  mqttUrl: string;
  mongoUrl: string;
}

// Separate env names from the api's MQTT_URL / MONGO_URL on purpose. A shell
// that exports MQTT_URL for the dev api would otherwise send eval traffic to
// the dev listener on 1883. 1884 is the eval listener (mount_point eval/).
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EvalConfig {
  return {
    mqttUrl: env['EVAL_MQTT_URL'] || 'mqtt://localhost:1884',
    mongoUrl: env['EVAL_MONGO_URL'] || 'mongodb://localhost:27017',
  };
}

// env for the api child. DB name and client ID always win over whatever the
// parent shell has set.
export function apiEnv(
  config: EvalConfig,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    MQTT_URL: config.mqttUrl,
    MONGO_URL: config.mongoUrl,
    MONGO_DB: EVAL_DB,
    MQTT_CLIENT_ID: EVAL_CLIENT_ID,
  };
}
