export interface Config {
  mqttUrl: string;
  // fixed so the broker keeps our persistent session across restarts
  mqttClientId: string;
  mongoUrl: string;
  mongoDb: string;
  // /ws/devices only exists when DASHBOARD_ENABLED is exactly "true"
  dashboardEnabled: boolean;
  httpHost: string;
  // 0 picks a free port, which the eval runner relies on
  httpPort: number;
  // an armed device alerts when its battery drops below this
  alertLowBatteryBelow: number;
  // an alerted device re-arms at or above this. Always above the low mark, so
  // a battery hovering around the line can't alert over and over.
  alertRearmAt: number;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    throw new Error(
      `HTTP_PORT must be an integer from 0 to 65535, got "${raw}"`,
    );
  }
  return port;
}

function parseBatteryLevel(name: string, raw: string): number {
  const level = Number(raw);
  if (!/^\d+$/.test(raw) || level > 100) {
    throw new Error(`${name} must be an integer from 0 to 100, got "${raw}"`);
  }
  return level;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const alertLowBatteryBelow = env.ALERT_LOW_BATTERY_BELOW
    ? parseBatteryLevel('ALERT_LOW_BATTERY_BELOW', env.ALERT_LOW_BATTERY_BELOW)
    : 15;
  const alertRearmAt = env.ALERT_REARM_AT
    ? parseBatteryLevel('ALERT_REARM_AT', env.ALERT_REARM_AT)
    : 20;
  if (alertRearmAt <= alertLowBatteryBelow) {
    throw new Error(
      `ALERT_REARM_AT (${alertRearmAt}) must be greater than ALERT_LOW_BATTERY_BELOW (${alertLowBatteryBelow})`,
    );
  }

  return {
    mqttUrl: env.MQTT_URL || 'mqtt://localhost:1883',
    mqttClientId: env.MQTT_CLIENT_ID || 'beaconyard-api',
    mongoUrl: env.MONGO_URL || 'mongodb://localhost:27017',
    mongoDb: env.MONGO_DB || 'beaconyard',
    dashboardEnabled: env.DASHBOARD_ENABLED === 'true',
    httpHost: env.HTTP_HOST || '127.0.0.1',
    httpPort: env.HTTP_PORT ? parsePort(env.HTTP_PORT) : 3000,
    alertLowBatteryBelow,
    alertRearmAt,
  };
}
