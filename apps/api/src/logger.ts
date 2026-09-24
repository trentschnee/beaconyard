// console fits this shape. Fastify runs with its own logger off and doesn't
// replace this one (out of scope for spec 04).
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
