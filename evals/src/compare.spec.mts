import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeviceState } from '@beaconyard/contracts';
import {
  canonical,
  compareState,
  formatMismatches,
  type ActualState,
  type Doc,
} from './compare.mts';
import type { ExpectedReject, ScenarioExpect } from './schema.mts';

const TOPIC = 'devices/c-1/heartbeat';

function hb(seq: number, battery = 90): DeviceState {
  return {
    deviceId: 'c-1',
    seq,
    ts: `2026-09-24T10:0${seq}:00Z`,
    battery,
    status: 'ok',
  };
}

// what the driver hands back: the stored fields plus an _id
function stored(doc: object): Doc {
  return { _id: `id-${Math.random()}`, ...doc };
}

function storedReject(reason: string, topic = TOPIC): Doc {
  return stored({
    topic,
    payload: 'not json',
    reason,
    receivedAt: new Date(),
  });
}

function expectOf(parts: Partial<ScenarioExpect>): ScenarioExpect {
  return { devices: [], events: [], rejects: [], ...parts };
}

function actualOf(parts: Partial<ActualState>): ActualState {
  return { devices: [], events: [], rejects: [], ...parts };
}

function failingParts(expect: ScenarioExpect, actual: ActualState): string[] {
  return compareState(expect, actual).map((m) => m.part);
}

describe('compareState: devices and events', () => {
  it('matches in any order and ignores _id', () => {
    const expect = expectOf({
      devices: [hb(3)],
      events: [hb(1), hb(2), hb(3)],
    });
    const actual = actualOf({
      devices: [stored(hb(3))],
      events: [stored(hb(3)), stored(hb(1)), stored(hb(2))],
    });
    assert.deepEqual(compareState(expect, actual), []);
  });

  it('matches regardless of key order', () => {
    const { status, battery, ts, seq, deviceId } = hb(1);
    const actual = actualOf({
      devices: [{ status, battery, ts, seq, deviceId, _id: 'x' }],
    });
    assert.deepEqual(compareState(expectOf({ devices: [hb(1)] }), actual), []);
  });

  it('fails on a changed field and shows both sides', () => {
    const mismatches = compareState(
      expectOf({ devices: [hb(1, 80)] }),
      actualOf({ devices: [stored(hb(1, 90))] }),
    );
    assert.deepEqual(mismatches, [
      {
        part: 'devices',
        expected: [canonical(hb(1, 80))],
        actual: [canonical(hb(1, 90))],
      },
    ]);
  });

  it('fails on a missing doc', () => {
    const expect = expectOf({ events: [hb(1), hb(2)] });
    const actual = actualOf({ events: [stored(hb(1))] });
    assert.deepEqual(failingParts(expect, actual), ['events']);
  });

  it('fails on an extra doc', () => {
    const expect = expectOf({ events: [hb(1)] });
    const actual = actualOf({ events: [stored(hb(1)), stored(hb(2))] });
    assert.deepEqual(failingParts(expect, actual), ['events']);
  });

  it('fails on a duplicated doc', () => {
    const expect = expectOf({ events: [hb(1)] });
    const actual = actualOf({ events: [stored(hb(1)), stored(hb(1))] });
    assert.deepEqual(failingParts(expect, actual), ['events']);
  });

  it('fails when the api stores a field the scenario does not list', () => {
    const expect = expectOf({ events: [hb(1)] });
    const actual = actualOf({
      events: [stored({ ...hb(1), receivedAt: new Date() })],
    });
    assert.deepEqual(failingParts(expect, actual), ['events']);
  });

  it('fails when a value has the wrong type but prints the same', () => {
    const expected = { ...hb(1), ts: '2026-09-24T10:01:00.000Z' };
    const actual = actualOf({
      devices: [stored({ ...expected, ts: new Date(expected.ts) })],
    });
    assert.deepEqual(failingParts(expectOf({ devices: [expected] }), actual), [
      'devices',
    ]);
  });

  it('reports only the parts that differ', () => {
    const expect = expectOf({ devices: [hb(2, 80)], events: [hb(1), hb(2)] });
    const actual = actualOf({
      devices: [stored(hb(2, 90))],
      events: [stored(hb(1)), stored(hb(2))],
    });
    assert.deepEqual(failingParts(expect, actual), ['devices']);
  });
});

describe('compareState: rejects', () => {
  const invalidJson: ExpectedReject = {
    topic: TOPIC,
    reasonStartsWith: 'payload is not valid JSON',
  };

  it('matches on topic and reason prefix, ignoring payload and receivedAt', () => {
    const actual = actualOf({
      rejects: [storedReject('payload is not valid JSON')],
    });
    assert.deepEqual(
      compareState(expectOf({ rejects: [invalidJson] }), actual),
      [],
    );
  });

  it('counts append-only duplicates', () => {
    const twice = actualOf({
      rejects: [
        storedReject('payload is not valid JSON'),
        storedReject('payload is not valid JSON'),
      ],
    });
    assert.deepEqual(
      compareState(expectOf({ rejects: [invalidJson, invalidJson] }), twice),
      [],
    );
    assert.deepEqual(
      failingParts(expectOf({ rejects: [invalidJson] }), twice),
      ['rejects'],
    );
  });

  it('fails on a reject nobody expected', () => {
    const actual = actualOf({
      rejects: [storedReject('payload is not valid JSON')],
    });
    assert.deepEqual(failingParts(expectOf({}), actual), ['rejects']);
  });

  it('fails when an expected reject never happens', () => {
    assert.deepEqual(
      failingParts(expectOf({ rejects: [invalidJson] }), actualOf({})),
      ['rejects'],
    );
  });

  it('fails on the wrong topic', () => {
    const actual = actualOf({
      rejects: [
        storedReject('payload is not valid JSON', 'devices/c-1/replay'),
      ],
    });
    assert.deepEqual(
      failingParts(expectOf({ rejects: [invalidJson] }), actual),
      ['rejects'],
    );
  });

  it('fails when the reason does not start with the prefix', () => {
    const actual = actualOf({
      rejects: [storedReject('batch: payload is not valid JSON')],
    });
    assert.deepEqual(
      failingParts(expectOf({ rejects: [invalidJson] }), actual),
      ['rejects'],
    );
  });

  it('pairs overlapping prefixes so each expected reject gets its own', () => {
    // pairing greedily in order would give "entry" the "entry 3:" reject and
    // leave nothing for the narrower prefix
    const expect = expectOf({
      rejects: [
        { topic: TOPIC, reasonStartsWith: 'entry' },
        { topic: TOPIC, reasonStartsWith: 'entry 3:' },
      ],
    });
    const actual = actualOf({
      rejects: [
        storedReject('entry 3: battery must be an integer from 0 to 100'),
        storedReject('entry 1: seq must be a safe integer >= 1'),
      ],
    });
    assert.deepEqual(compareState(expect, actual), []);
  });

  it('shows topic and reason of the actual rejects on failure', () => {
    const [mismatch] = compareState(
      expectOf({}),
      actualOf({ rejects: [storedReject('payload is not valid JSON')] }),
    );
    assert.deepEqual(mismatch, {
      part: 'rejects',
      expected: [],
      actual: [
        canonical({ topic: TOPIC, reason: 'payload is not valid JSON' }),
      ],
    });
  });
});

describe('canonical', () => {
  it('sorts keys and tags values that are not plain JSON', () => {
    assert.equal(
      canonical({ b: 1, a: [true, null] }),
      '{"a":[true,null],"b":1}',
    );
    assert.equal(
      canonical(new Date('2026-09-24T10:00:00Z')),
      '{"$date":"2026-09-24T10:00:00.000Z"}',
    );
    assert.equal(
      canonical(new URL('mqtt://x')),
      '{"$type":"URL","value":"mqtt://x"}',
    );
  });
});

describe('formatMismatches', () => {
  it('names each failing part with its expected and actual docs', () => {
    const lines = formatMismatches(
      compareState(
        expectOf({ devices: [hb(1, 80)], rejects: [] }),
        actualOf({
          devices: [stored(hb(1, 90))],
          rejects: [storedReject('payload is not valid JSON')],
        }),
      ),
    );
    assert.deepEqual(lines, [
      '  devices:',
      '    expected:',
      `      ${canonical(hb(1, 80))}`,
      '    actual:',
      `      ${canonical(hb(1, 90))}`,
      '  rejects:',
      '    expected:',
      '      (none)',
      '    actual:',
      `      ${canonical({ topic: TOPIC, reason: 'payload is not valid JSON' })}`,
    ]);
  });
});
