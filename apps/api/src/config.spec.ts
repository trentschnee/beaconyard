import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses local defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      mqttUrl: 'mqtt://localhost:1883',
      mqttClientId: 'beaconyard-api',
      mongoUrl: 'mongodb://localhost:27017',
      mongoDb: 'beaconyard',
      dashboardEnabled: false,
      httpHost: '127.0.0.1',
      httpPort: 3000,
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
    ).toEqual(
      expect.objectContaining({
        mqttUrl: 'mqtt://broker:1883',
        mqttClientId: 'api-2',
        mongoUrl: 'mongodb://db:27017',
        mongoDb: 'other',
      }),
    );
  });

  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['1', '1'],
    ['TRUE', 'TRUE'],
    ['empty', ''],
  ])(
    'S04-AT11: DASHBOARD_ENABLED %s leaves the dashboard off',
    (_label, value) => {
      expect(loadConfig({ DASHBOARD_ENABLED: value }).dashboardEnabled).toBe(
        false,
      );
    },
  );

  it('S04-AT11: DASHBOARD_ENABLED "true" turns the dashboard on', () => {
    expect(loadConfig({ DASHBOARD_ENABLED: 'true' }).dashboardEnabled).toBe(
      true,
    );
  });

  it('S04-AT11: HTTP_HOST and HTTP_PORT default to 127.0.0.1:3000', () => {
    const config = loadConfig({ DASHBOARD_ENABLED: 'true' });
    expect(config.httpHost).toBe('127.0.0.1');
    expect(config.httpPort).toBe(3000);
  });

  it('reads HTTP_HOST and HTTP_PORT', () => {
    const config = loadConfig({ HTTP_HOST: '0.0.0.0', HTTP_PORT: '8080' });
    expect(config.httpHost).toBe('0.0.0.0');
    expect(config.httpPort).toBe(8080);
  });

  it('accepts HTTP_PORT 0 and 65535', () => {
    expect(loadConfig({ HTTP_PORT: '0' }).httpPort).toBe(0);
    expect(loadConfig({ HTTP_PORT: '65535' }).httpPort).toBe(65535);
  });

  it.each(['abc', '-1', '65536', '80.5', ' 80', '1e3'])(
    'rejects HTTP_PORT %p',
    (value) => {
      expect(() => loadConfig({ HTTP_PORT: value })).toThrow(/HTTP_PORT/);
    },
  );
});
