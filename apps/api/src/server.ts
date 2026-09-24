import { fastifyWebsocket } from '@fastify/websocket';
import { fastify, type FastifyInstance } from 'fastify';
import type { Logger } from './logger';
import type { DashboardHub } from './ws/dashboard';

export const DASHBOARD_PATH = '/ws/devices';

export interface ServerOptions {
  logger: Logger;
  // Only passed when DASHBOARD_ENABLED is on. Without it the websocket plugin
  // isn't registered at all, nothing listens for upgrades, and Node hands an
  // upgrade request to Fastify as a plain request, which 404s.
  dashboard?: DashboardHub;
}

export async function createServer({
  logger,
  dashboard,
}: ServerOptions): Promise<FastifyInstance> {
  // Fastify's own logger stays off; the api logs through ours
  const app = fastify({ logger: false });

  if (dashboard) {
    await app.register(fastifyWebsocket, {
      // the plugin's default handler logs to Fastify's logger, which is off.
      // These are client-side protocol errors, not broadcast failures.
      errorHandler: (err, socket) => {
        logger.warn('dashboard socket error', { err });
        socket.terminate();
      },
    });
    // a plain GET without an upgrade gets the plugin's 404
    app.get(DASHBOARD_PATH, { websocket: true }, (socket) =>
      dashboard.connect(socket),
    );
  }

  return app;
}
