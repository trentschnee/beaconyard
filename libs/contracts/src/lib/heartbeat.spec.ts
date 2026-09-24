import { parseHeartbeat } from './heartbeat';

const valid = {
  seq: 5,
  ts: '2026-09-23T10:00:00Z',
  battery: 80,
  status: 'ok',
};

function parse(overrides: Record<string, unknown>) {
  return parseHeartbeat(JSON.stringify({ ...valid, ...overrides }));
}

function without(key: keyof typeof valid) {
  const copy: Record<string, unknown> = { ...valid };
  delete copy[key];
  return parseHeartbeat(JSON.stringify(copy));
}

function reasonOf(result: ReturnType<typeof parseHeartbeat>): string {
  if (result.ok) {
    throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  }
  return result.reason;
}

describe('parseHeartbeat', () => {
  it('returns exactly the four heartbeat fields for a valid payload', () => {
    expect(parseHeartbeat(JSON.stringify(valid))).toEqual({
      ok: true,
      value: valid,
    });
  });

  it('drops unknown fields, including a payload deviceId', () => {
    const result = parse({ firmware: '1.2', deviceId: 'spoofed' });
    expect(result).toEqual({ ok: true, value: valid });
  });

  it('rejects malformed JSON', () => {
    expect(reasonOf(parseHeartbeat('{"seq": 5,'))).toMatch(/JSON/);
  });

  it.each(['null', '[]', '42', '"x"'])('rejects non-object JSON %s', (raw) => {
    expect(reasonOf(parseHeartbeat(raw))).toMatch(/object/);
  });

  describe('seq', () => {
    it.each([0, -1, 1.5, '5', 2 ** 53])('rejects %p', (seq) => {
      expect(reasonOf(parse({ seq }))).toMatch(/^seq /);
    });

    it('rejects a missing seq', () => {
      expect(reasonOf(without('seq'))).toMatch(/^seq /);
    });

    it.each([1, Number.MAX_SAFE_INTEGER])('accepts %p', (seq) => {
      expect(parse({ seq })).toEqual({ ok: true, value: { ...valid, seq } });
    });
  });

  describe('ts', () => {
    it.each([
      ['a number', 1727085600000],
      ['date only', '2026-09-23'],
      ['space separator', '2026-09-23 10:00:00Z'],
      ['no zone', '2026-09-23T10:00:00'],
      ['lowercase t', '2026-09-23t10:00:00Z'],
      ['lowercase z', '2026-09-23T10:00:00z'],
      ['Feb 30', '2026-02-30T00:00:00Z'],
      ['Feb 29 outside a leap year', '2026-02-29T00:00:00Z'],
      ['month 13', '2026-13-01T00:00:00Z'],
      ['hour 24', '2026-09-23T24:00:00Z'],
      ['offset +25:00', '2026-09-23T10:00:00+25:00'],
      ['offset minutes 60', '2026-09-23T10:00:00+05:60'],
      ['leap second', '2026-12-31T23:59:60Z'],
    ])('rejects %s', (_label, ts) => {
      expect(reasonOf(parse({ ts }))).toMatch(/^ts /);
    });

    it('rejects a missing ts', () => {
      expect(reasonOf(without('ts'))).toMatch(/^ts /);
    });

    it.each([
      '2024-02-29T00:00:00Z',
      '2026-09-23T10:00:00.123Z',
      '2026-09-23T10:00:00.123456789+02:00',
      '2026-09-23T10:00:00+05:30',
      '2026-09-23T10:00:00-00:00',
    ])('accepts %s and keeps it unchanged', (ts) => {
      expect(parse({ ts })).toEqual({ ok: true, value: { ...valid, ts } });
    });
  });

  describe('battery', () => {
    it.each([-1, 101, 150, 50.5, '50'])('rejects %p', (battery) => {
      expect(reasonOf(parse({ battery }))).toMatch(/^battery /);
    });

    it('rejects a missing battery', () => {
      expect(reasonOf(without('battery'))).toMatch(/^battery /);
    });

    it.each([0, 100])('accepts %p', (battery) => {
      expect(parse({ battery })).toEqual({
        ok: true,
        value: { ...valid, battery },
      });
    });
  });

  describe('status', () => {
    it.each(['sleeping', 'OK'])('rejects %p', (status) => {
      expect(reasonOf(parse({ status }))).toMatch(/^status /);
    });

    it('rejects a missing status', () => {
      expect(reasonOf(without('status'))).toMatch(/^status /);
    });

    it.each(['ok', 'warning', 'fault'])('accepts %p', (status) => {
      expect(parse({ status })).toEqual({
        ok: true,
        value: { ...valid, status },
      });
    });
  });

  it('reports the first failure in the order seq, ts, battery, status', () => {
    const allBad = { seq: 0, ts: 'bad', battery: 150, status: 'sleeping' };
    expect(reasonOf(parse(allBad))).toMatch(/^seq/);
    expect(reasonOf(parse({ ...allBad, seq: 1 }))).toMatch(/^ts/);
    expect(reasonOf(parse({ ...allBad, seq: 1, ts: valid.ts }))).toMatch(
      /^battery/,
    );
    expect(
      reasonOf(parse({ ...allBad, seq: 1, ts: valid.ts, battery: 50 })),
    ).toMatch(/^status/);
  });
});
