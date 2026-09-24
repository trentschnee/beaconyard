import { MAX_REPLAY_BATCH, parseReplayBatch } from './replay';

function hb(seq: number) {
  return {
    seq,
    ts: `2026-09-24T10:00:${String(seq % 60).padStart(2, '0')}Z`,
    battery: seq % 101,
    status: 'ok',
  };
}

function parse(entries: unknown[]) {
  return parseReplayBatch(JSON.stringify(entries));
}

function valueOf(result: ReturnType<typeof parseReplayBatch>) {
  if (!result.ok) {
    throw new Error(`expected a batch, got failure: ${result.reason}`);
  }
  return result.value;
}

function reasonOf(result: ReturnType<typeof parseReplayBatch>): string {
  if (result.ok) {
    throw new Error('expected a batch failure');
  }
  return result.reason;
}

describe('parseReplayBatch', () => {
  it('returns valid entries in array order, repeated seqs included', () => {
    const entries = [hb(3), hb(1), hb(2), { ...hb(3), battery: 7 }];

    expect(parse(entries)).toEqual({
      ok: true,
      value: { heartbeats: entries, errors: [] },
    });
  });

  it('drops unknown fields from each entry, including a payload deviceId', () => {
    const result = parse([{ ...hb(1), firmware: '1.2', deviceId: 'spoofed' }]);

    expect(valueOf(result).heartbeats).toEqual([hb(1)]);
  });

  it('accepts an empty array', () => {
    expect(parseReplayBatch('[]')).toEqual({
      ok: true,
      value: { heartbeats: [], errors: [] },
    });
  });

  it('fails the whole batch on malformed JSON', () => {
    expect(reasonOf(parseReplayBatch('[{"seq": 1,'))).toMatch(/^batch: .*JSON/);
  });

  it.each(['{}', 'null', '42', '"x"', JSON.stringify(hb(1))])(
    'fails the whole batch when the payload is %s',
    (raw) => {
      expect(reasonOf(parseReplayBatch(raw))).toMatch(/^batch: .*array/);
    },
  );

  it(`accepts exactly ${MAX_REPLAY_BATCH} entries`, () => {
    const entries = Array.from({ length: MAX_REPLAY_BATCH }, (_, i) =>
      hb(i + 1),
    );

    expect(valueOf(parse(entries)).heartbeats).toHaveLength(MAX_REPLAY_BATCH);
  });

  it(`fails the whole batch at ${MAX_REPLAY_BATCH + 1} entries, even with invalid ones inside`, () => {
    const entries: unknown[] = Array.from(
      { length: MAX_REPLAY_BATCH + 1 },
      (_, i) => hb(i + 1),
    );
    entries[3] = { ...hb(4), battery: 150 };

    const reason = reasonOf(parse(entries));

    expect(reason).toMatch(/^batch: /);
    expect(reason).toContain(String(MAX_REPLAY_BATCH));
  });

  describe('invalid entries', () => {
    it.each([
      ['seq', { ...hb(3), seq: 0 }, /^entry 1: seq /],
      ['ts', { ...hb(3), ts: '2026-09-24' }, /^entry 1: ts /],
      ['battery', { ...hb(3), battery: 150 }, /^entry 1: battery /],
      ['status', { ...hb(3), status: 'sleeping' }, /^entry 1: status /],
      [
        'a missing seq',
        { ts: hb(3).ts, battery: 3, status: 'ok' },
        /^entry 1: seq /,
      ],
      ['a number', 42, /^entry 1: .*object/],
      ['null', null, /^entry 1: .*object/],
      ['an array', [hb(3)], /^entry 1: .*object/],
    ])(
      'reports %s with its index and keeps the rest',
      (_label, bad, reason) => {
        const result = parse([hb(1), bad, hb(2)]);

        expect(valueOf(result)).toEqual({
          heartbeats: [hb(1), hb(2)],
          errors: [
            {
              index: 1,
              payload: JSON.stringify(bad),
              reason: expect.stringMatching(reason),
            },
          ],
        });
      },
    );

    it('reports every invalid entry separately', () => {
      const result = parse([
        { ...hb(1), battery: -1 },
        hb(2),
        hb(3),
        { ...hb(4), status: 'OK' },
      ]);

      expect(valueOf(result).heartbeats).toEqual([hb(2), hb(3)]);
      expect(valueOf(result).errors.map((e) => [e.index, e.reason])).toEqual([
        [0, expect.stringMatching(/^entry 0: battery /)],
        [3, expect.stringMatching(/^entry 3: status /)],
      ]);
    });

    it('uses the same field reason a live heartbeat gets', () => {
      const result = parse([{ ...hb(1), battery: 150 }]);

      expect(valueOf(result).errors[0].reason).toBe(
        'entry 0: battery must be an integer from 0 to 100',
      );
    });
  });
});
