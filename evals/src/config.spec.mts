import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apiEnv, loadConfig } from './config.mts';

describe('loadConfig', () => {
  it('defaults to the eval listener and local Mongo', () => {
    assert.deepEqual(loadConfig({}), {
      mqttUrl: 'mqtt://localhost:1884',
      mongoUrl: 'mongodb://localhost:27017',
    });
  });

  it("ignores the dev api's MQTT_URL and MONGO_URL", () => {
    const config = loadConfig({
      MQTT_URL: 'mqtt://localhost:1883',
      MONGO_URL: 'mongodb://elsewhere:27017',
    });
    assert.equal(config.mqttUrl, 'mqtt://localhost:1884');
    assert.equal(config.mongoUrl, 'mongodb://localhost:27017');
  });

  it('reads EVAL_MQTT_URL and EVAL_MONGO_URL', () => {
    assert.deepEqual(
      loadConfig({
        EVAL_MQTT_URL: 'mqtt://127.0.0.1:9',
        EVAL_MONGO_URL: 'mongodb://127.0.0.1:9',
      }),
      { mqttUrl: 'mqtt://127.0.0.1:9', mongoUrl: 'mongodb://127.0.0.1:9' },
    );
  });
});

describe('apiEnv', () => {
  const config = {
    mqttUrl: 'mqtt://localhost:1884',
    mongoUrl: 'mongodb://localhost:27017',
  };

  it('points the api at the eval database and client ID, whatever the shell says', () => {
    const env = apiEnv(config, {
      MONGO_DB: 'beaconyard',
      MQTT_CLIENT_ID: 'beaconyard-api',
      MQTT_URL: 'mqtt://localhost:1883',
      HTTP_PORT: '3000',
      PATH: '/usr/bin',
    });
    assert.deepEqual(env, {
      MONGO_DB: 'beaconyard_eval',
      MQTT_CLIENT_ID: 'beaconyard-eval',
      MQTT_URL: 'mqtt://localhost:1884',
      MONGO_URL: 'mongodb://localhost:27017',
      HTTP_PORT: '0',
      PATH: '/usr/bin',
    });
  });
});
