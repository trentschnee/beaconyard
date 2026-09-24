import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses local defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      mqttClientId: 'beaconyard-api',
      mongoUrl: 'mongodb://localhost:27017',
      mongoDb: 'beaconyard',
    });
  });

  it('reads MQTT_URL, MQTT_CLIENT_ID, MONGO_URL and MONGO_DB', () => {
    expect(
      loadConfig({
        MQTT_URL: 'mqtt://broker:1883',
        MQTT_CLIENT_ID: 'api-2',
        MONGO_URL: 'mongodb://db:27017',
        MONGO_DB: 'other',
      }),
    ).toEqual({
      mqttUrl: 'mqtt://broker:1883',
      mqttClientId: 'api-2',
      mongoUrl: 'mongodb://db:27017',
      mongoDb: 'other',
    });
  });
});
