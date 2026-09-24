import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses local defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      mongoUrl: 'mongodb://localhost:27017',
      mongoDb: 'beaconyard',
    });
  });

  it('reads MQTT_URL, MONGO_URL and MONGO_DB', () => {
    expect(
      loadConfig({
        MQTT_URL: 'mqtt://broker:1883',
        MONGO_URL: 'mongodb://db:27017',
        MONGO_DB: 'other',
      }),
    ).toEqual({
      mqttUrl: 'mqtt://broker:1883',
      mongoUrl: 'mongodb://db:27017',
      mongoDb: 'other',
    });
  });
});
