export const DEVICE_STATUSES = ['ok', 'warning', 'fault'] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export interface Heartbeat {
  seq: number;
  // device event time as sent, RFC 3339
  ts: string;
  battery: number;
  status: DeviceStatus;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

// YYYY-MM-DDTHH:mm:ss[.fraction](Z|+HH:MM|-HH:MM)
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isRfc3339(value: string): boolean {
  const m = RFC3339.exec(value);
  if (!m) {
    return false;
  }
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const offsetHour = m[7] === undefined ? 0 : Number(m[7]);
  const offsetMinute = m[8] === undefined ? 0 : Number(m[8]);
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  // Date.UTC rolls Feb 30 over to Mar 2, so a round trip catches days that don't exist
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function isDeviceStatus(value: unknown): value is DeviceStatus {
  return (DEVICE_STATUSES as readonly unknown[]).includes(value);
}

export function parseHeartbeat(raw: string): ParseResult<Heartbeat> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'payload is not valid JSON' };
  }
  return validateHeartbeat(data);
}

// For an already-parsed value, e.g. one entry of a replay batch. Checks run in
// a fixed order (seq, ts, battery, status) and the first failure is reported.
// Only the known fields are copied out, so extra keys are dropped.
export function validateHeartbeat(data: unknown): ParseResult<Heartbeat> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'payload must be a JSON object' };
  }
  const obj = data as Record<string, unknown>;

  const seq = obj['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    return { ok: false, reason: 'seq must be a safe integer >= 1' };
  }

  const ts = obj['ts'];
  if (typeof ts !== 'string' || !isRfc3339(ts)) {
    return { ok: false, reason: 'ts must be an RFC 3339 timestamp' };
  }

  const battery = obj['battery'];
  if (
    typeof battery !== 'number' ||
    !Number.isInteger(battery) ||
    battery < 0 ||
    battery > 100
  ) {
    return { ok: false, reason: 'battery must be an integer from 0 to 100' };
  }

  const status = obj['status'];
  if (!isDeviceStatus(status)) {
    return {
      ok: false,
      reason: `status must be one of ${DEVICE_STATUSES.join(', ')}`,
    };
  }

  return { ok: true, value: { seq, ts, battery, status } };
}
