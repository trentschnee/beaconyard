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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mqttUrl: env.MQTT_URL || 'mqtt://localhost:1883',
    mqttClientId: env.MQTT_CLIENT_ID || 'beaconyard-api',
    mongoUrl: env.MONGO_URL || 'mongodb://localhost:27017',
    mongoDb: env.MONGO_DB || 'beaconyard',
    dashboardEnabled: env.DASHBOARD_ENABLED === 'true',
    httpHost: env.HTTP_HOST || '127.0.0.1',
    httpPort: env.HTTP_PORT ? parsePort(env.HTTP_PORT) : 3000,
  };
}
