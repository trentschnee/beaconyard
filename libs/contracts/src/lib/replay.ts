import {
  validateHeartbeat,
  type Heartbeat,
  type ParseResult,
} from './heartbeat';

export const MAX_REPLAY_BATCH = 1000;

// devices/<id>/replay: heartbeats the device buffered while offline, sent as
// one JSON array when it reconnects
export type ReplayBatch = Heartbeat[];

export interface ReplayEntryError {
  // 0-based position in the batch
  index: number;
  // the entry re-serialized as JSON
  payload: string;
  // "entry <index>: " plus the reason a live heartbeat would get
  reason: string;
}

export interface ParsedReplayBatch {
  // valid entries in array order, repeated seqs included
  heartbeats: ReplayBatch;
  errors: ReplayEntryError[];
}

// A bad batch (not JSON, not an array, over the cap) fails as a whole. Past
// that, each entry is validated on its own so one bad entry doesn't sink the
// rest.
export function parseReplayBatch(raw: string): ParseResult<ParsedReplayBatch> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'batch: payload is not valid JSON' };
  }
  if (!Array.isArray(data)) {
    return { ok: false, reason: 'batch: payload must be a JSON array' };
  }
  if (data.length > MAX_REPLAY_BATCH) {
    return {
      ok: false,
      reason: `batch: ${data.length} entries exceeds the max of ${MAX_REPLAY_BATCH}`,
    };
  }

  const heartbeats: ReplayBatch = [];
  const errors: ReplayEntryError[] = [];
  data.forEach((entry: unknown, index) => {
    const result = validateHeartbeat(entry);
    if (result.ok) {
      heartbeats.push(result.value);
    } else {
      errors.push({
        index,
        payload: JSON.stringify(entry),
        reason: `entry ${index}: ${result.reason}`,
      });
    }
  });

  return { ok: true, value: { heartbeats, errors } };
}
