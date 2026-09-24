import type { ExpectedReject, ScenarioExpect } from './schema.mts';

export type Part = 'devices' | 'events' | 'rejects';

// a document as it comes back from the driver
export type Doc = Record<string, unknown>;

export interface ActualState {
  devices: Doc[];
  events: Doc[];
  rejects: Doc[];
}

export interface Mismatch {
  part: Part;
  // one canonical JSON line per document, sorted
  expected: string[];
  actual: string[];
}

// Stable JSON for comparing and printing. Keys are sorted, and anything that
// isn't plain JSON (Date, ObjectId, ...) is tagged with its type, so a Date
// can never equal the string it happens to print as.
export function canonical(value: unknown): string {
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value instanceof Date) {
    return `{"$date":${JSON.stringify(value.toISOString())}}`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `{"$type":${JSON.stringify(value.constructor.name)},"value":${JSON.stringify(String(value))}}`;
  }
  const fields = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Doc)[key])}`);
  return `{${fields.join(',')}}`;
}

function withoutId(doc: Doc): Doc {
  return Object.fromEntries(
    Object.entries(doc).filter(([key]) => key !== '_id'),
  );
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// exact match in any order, so a missing, extra, duplicated or changed doc
// fails, and so does a field the api wrote that the scenario doesn't list
function compareDocs(
  part: Part,
  expected: readonly object[],
  actual: readonly Doc[],
): Mismatch | undefined {
  const exp = expected.map(canonical).sort();
  const act = actual.map((doc) => canonical(withoutId(doc))).sort();
  return sameLines(exp, act) ? undefined : { part, expected: exp, actual: act };
}

function rejectMatches(expected: ExpectedReject, actual: Doc): boolean {
  const reason = actual['reason'];
  return (
    actual['topic'] === expected.topic &&
    typeof reason === 'string' &&
    reason.startsWith(expected.reasonStartsWith)
  );
}

// Largest one-to-one pairing of expected to actual rejects, via augmenting
// paths. Pairing greedily could give a broad prefix like "entry" the only
// reject that a narrower "entry 3:" can take, and fail a scenario that holds.
function maxPairing(
  expected: readonly ExpectedReject[],
  actual: readonly Doc[],
): number {
  const pairedWith = new Array<number>(actual.length).fill(-1);

  const pair = (e: number, visited: boolean[]): boolean => {
    for (let a = 0; a < actual.length; a++) {
      if (visited[a] || !rejectMatches(expected[e], actual[a])) {
        continue;
      }
      visited[a] = true;
      if (pairedWith[a] === -1 || pair(pairedWith[a], visited)) {
        pairedWith[a] = e;
        return true;
      }
    }
    return false;
  };

  let pairs = 0;
  for (let e = 0; e < expected.length; e++) {
    if (pair(e, new Array<boolean>(actual.length).fill(false))) {
      pairs++;
    }
  }
  return pairs;
}

// rejects match on topic and reason prefix; payload and receivedAt are ignored
function compareRejects(
  expected: readonly ExpectedReject[],
  actual: readonly Doc[],
): Mismatch | undefined {
  const matched =
    expected.length === actual.length &&
    maxPairing(expected, actual) === expected.length;
  if (matched) {
    return undefined;
  }
  return {
    part: 'rejects',
    expected: expected.map(canonical).sort(),
    actual: actual
      .map((doc) => canonical({ topic: doc['topic'], reason: doc['reason'] }))
      .sort(),
  };
}

export function compareState(
  expect: ScenarioExpect,
  actual: ActualState,
): Mismatch[] {
  return [
    compareDocs('devices', expect.devices, actual.devices),
    compareDocs('events', expect.events, actual.events),
    compareRejects(expect.rejects, actual.rejects),
  ].filter((m): m is Mismatch => m !== undefined);
}

export function formatMismatches(mismatches: readonly Mismatch[]): string[] {
  const lines: string[] = [];
  const list = (label: string, docs: readonly string[]) => {
    lines.push(`    ${label}:`);
    if (docs.length === 0) {
      lines.push('      (none)');
    }
    for (const doc of docs) {
      lines.push(`      ${doc}`);
    }
  };
  for (const { part, expected, actual } of mismatches) {
    lines.push(`  ${part}:`);
    list('expected', expected);
    list('actual', actual);
  }
  return lines;
}
