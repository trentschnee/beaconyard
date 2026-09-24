export interface Config {
  mqttUrl: string;
  // fixed so the broker keeps our persistent session across restarts
  mqttClientId: string;
  mongoUrl: string;
  mongoDb: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mqttUrl: env.MQTT_URL || 'mqtt://localhost:1883',
    mqttClientId: env.MQTT_CLIENT_ID || 'beaconyard-api',
    mongoUrl: env.MONGO_URL || 'mongodb://localhost:27017',
    mongoDb: env.MONGO_DB || 'beaconyard',
  };
}
