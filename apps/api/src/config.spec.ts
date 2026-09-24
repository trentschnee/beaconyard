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
      alertLowBatteryBelow: 15,
      alertRearmAt: 20,
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

  it('S05-AT14: alert thresholds default to 15 and 20', () => {
    const config = loadConfig({});
    expect(config.alertLowBatteryBelow).toBe(15);
    expect(config.alertRearmAt).toBe(20);
  });

  it('S05-AT14: reads ALERT_LOW_BATTERY_BELOW and ALERT_REARM_AT', () => {
    const config = loadConfig({
      ALERT_LOW_BATTERY_BELOW: '30',
      ALERT_REARM_AT: '45',
    });
    expect(config.alertLowBatteryBelow).toBe(30);
    expect(config.alertRearmAt).toBe(45);
  });

  it('S05-AT14: accepts thresholds at 0 and 100', () => {
    const config = loadConfig({
      ALERT_LOW_BATTERY_BELOW: '0',
      ALERT_REARM_AT: '100',
    });
    expect(config.alertLowBatteryBelow).toBe(0);
    expect(config.alertRearmAt).toBe(100);
  });

  describe.each(['ALERT_LOW_BATTERY_BELOW', 'ALERT_REARM_AT'])('%s', (name) => {
    it.each(['abc', '-1', '101', '15.5', ' 15', '1e1'])(
      'S05-AT14: rejects %p',
      (value) => {
        expect(() => loadConfig({ [name]: value })).toThrow(
          new RegExp(`^${name} must be an integer from 0 to 100`),
        );
      },
    );
  });

  it.each([
    [
      'ALERT_REARM_AT equal to ALERT_LOW_BATTERY_BELOW',
      { ALERT_LOW_BATTERY_BELOW: '20', ALERT_REARM_AT: '20' },
    ],
    [
      'ALERT_REARM_AT below ALERT_LOW_BATTERY_BELOW',
      { ALERT_LOW_BATTERY_BELOW: '20', ALERT_REARM_AT: '10' },
    ],
    [
      'ALERT_LOW_BATTERY_BELOW 20 against the default ALERT_REARM_AT',
      { ALERT_LOW_BATTERY_BELOW: '20' },
    ],
    [
      'ALERT_REARM_AT 15 against the default ALERT_LOW_BATTERY_BELOW',
      { ALERT_REARM_AT: '15' },
    ],
  ])('S05-AT14: rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(
      /ALERT_REARM_AT .* must be greater than ALERT_LOW_BATTERY_BELOW/,
    );
  });
});
