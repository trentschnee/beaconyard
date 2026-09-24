import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadScenario, validateScenario } from './schema.mts';

const TOPIC = 'devices/u-1/heartbeat';
const DOC = {
  deviceId: 'u-1',
  seq: 1,
  ts: '2026-09-24T10:00:00Z',
  battery: 90,
  status: 'ok',
};

// a valid scenario; each test breaks one piece of a fresh copy
function scenario(): Record<string, unknown> {
  return {
    name: 'unit',
    description: 'A valid scenario that each test breaks one piece of.',
    messages: [
      {
        topic: TOPIC,
        payload: { seq: 1, ts: DOC.ts, battery: 90, status: 'ok' },
      },
      { topic: 'devices/u-1/replay', payload: [] },
      { topic: TOPIC, raw: 'not json' },
    ],
    expect: {
      devices: [{ ...DOC }],
      events: [{ ...DOC }],
      rejects: [
        { topic: TOPIC, reasonStartsWith: 'payload is not valid JSON' },
      ],
    },
  };
}

function withExpect(
  change: (expect: Record<string, unknown>) => void,
): Record<string, unknown> {
  const data = scenario();
  change(data['expect'] as Record<string, unknown>);
  return data;
}

function withMessage(index: number, message: unknown): Record<string, unknown> {
  const data = scenario();
  (data['messages'] as unknown[])[index] = message;
  return data;
}

function problemOf(data: unknown): string {
  const result = validateScenario(data);
  if (result.ok) {
    assert.fail('expected the scenario to be rejected');
  }
  return result.problem;
}

describe('validateScenario', () => {
  it('accepts a valid scenario and returns it as is', () => {
    const data = scenario();
    assert.deepEqual(validateScenario(data), { ok: true, value: data });
  });

  it('accepts empty messages and empty expectations', () => {
    const data = {
      ...scenario(),
      messages: [],
      expect: { devices: [], events: [], rejects: [] },
    };
    assert.equal(validateScenario(data).ok, true);
  });

  it('rejects anything that is not a JSON object', () => {
    for (const data of [null, [], 'scenario', 42]) {
      assert.equal(problemOf(data), 'scenario must be a JSON object');
    }
  });

  for (const key of ['name', 'description', 'messages', 'expect']) {
    it(`names ${key} when it is missing`, () => {
      const data = scenario();
      delete data[key];
      assert.equal(problemOf(data), `${key} is required`);
    });
  }

  for (const key of ['devices', 'events', 'rejects']) {
    it(`names expect.${key} when it is missing`, () => {
      const data = withExpect((expect) => delete expect[key]);
      assert.equal(problemOf(data), `expect.${key} is required`);
    });
  }

  it('rejects an empty name', () => {
    assert.equal(
      problemOf({ ...scenario(), name: '' }),
      'name must be a non-empty string',
    );
  });

  it('rejects expect that is not an object', () => {
    assert.equal(
      problemOf({ ...scenario(), expect: [] }),
      'expect must be an object',
    );
  });

  it('rejects messages that is not an array', () => {
    assert.equal(
      problemOf({ ...scenario(), messages: {} }),
      'messages must be an array',
    );
  });

  it('rejects a message with both payload and raw', () => {
    const data = withMessage(1, { topic: TOPIC, payload: {}, raw: '{}' });
    assert.equal(
      problemOf(data),
      'messages[1] must have exactly one of payload or raw',
    );
  });

  it('rejects a message with neither payload nor raw', () => {
    const data = withMessage(0, { topic: TOPIC });
    assert.equal(
      problemOf(data),
      'messages[0] must have exactly one of payload or raw',
    );
  });

  it('accepts a null payload, since the key is present', () => {
    assert.equal(
      validateScenario(withMessage(0, { topic: TOPIC, payload: null })).ok,
      true,
    );
  });

  it('rejects a raw message that is not a string', () => {
    const data = withMessage(2, { topic: TOPIC, raw: 42 });
    assert.equal(problemOf(data), 'messages[2].raw must be a string');
  });

  it('rejects a missing or empty topic', () => {
    assert.equal(
      problemOf(withMessage(0, { payload: {} })),
      'messages[0].topic must be a non-empty string',
    );
    assert.equal(
      problemOf(withMessage(0, { topic: '', payload: {} })),
      'messages[0].topic must be a non-empty string',
    );
  });

  it('rejects a wildcard topic', () => {
    for (const topic of ['devices/+/heartbeat', 'devices/#']) {
      assert.equal(
        problemOf(withMessage(0, { topic, payload: {} })),
        'messages[0].topic must not contain + or #',
      );
    }
  });

  it('rejects an unknown key on a message', () => {
    const data = withMessage(0, { topic: TOPIC, payload: {}, qos: 0 });
    assert.equal(problemOf(data), 'messages[0] has unknown key "qos"');
  });

  it('rejects an expected device field of the wrong type', () => {
    const data = withExpect((expect) => {
      expect['devices'] = [{ ...DOC, battery: '90' }];
    });
    assert.equal(problemOf(data), 'expect.devices[0].battery must be a number');
  });

  it('rejects an expected device missing a field', () => {
    const noStatus: Record<string, unknown> = { ...DOC };
    delete noStatus['status'];
    const data = withExpect((expect) => {
      expect['devices'] = [noStatus];
    });
    assert.equal(problemOf(data), 'expect.devices[0] is missing status');
  });

  it('rejects an expected event with a field contracts does not define', () => {
    const data = withExpect((expect) => {
      expect['events'] = [{ ...DOC }, { ...DOC, seq: 2, receivedAt: 'now' }];
    });
    assert.equal(
      problemOf(data),
      'expect.events[1] has unknown key "receivedAt"',
    );
  });

  it('rejects an expected event that is not an object', () => {
    const data = withExpect((expect) => {
      expect['events'] = [1];
    });
    assert.equal(problemOf(data), 'expect.events[0] must be an object');
  });

  it('rejects an expected reject without reasonStartsWith', () => {
    const data = withExpect((expect) => {
      expect['rejects'] = [{ topic: TOPIC, reason: 'payload is not valid' }];
    });
    assert.equal(
      problemOf(data),
      'expect.rejects[0] is missing reasonStartsWith',
    );
  });

  it('rejects an expected reject with a non-string topic', () => {
    const data = withExpect((expect) => {
      expect['rejects'] = [{ topic: 1, reasonStartsWith: 'x' }];
    });
    assert.equal(problemOf(data), 'expect.rejects[0].topic must be a string');
  });

  it('rejects an unknown key in expect', () => {
    const data = withExpect((expect) => {
      expect['devicess'] = [];
    });
    assert.equal(problemOf(data), 'expect has unknown key "devicess"');
  });

  it('rejects an unknown top-level key', () => {
    assert.equal(
      problemOf({ ...scenario(), expects: {} }),
      'scenario has unknown key "expects"',
    );
  });
});

describe('loadScenario', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'beaconyard-evals-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and validates a scenario file', async () => {
    const path = join(dir, 'valid.json');
    await writeFile(path, JSON.stringify(scenario()));
    assert.deepEqual(await loadScenario(path), {
      ok: true,
      value: scenario(),
    });
  });

  it('names expect when the file has none', async () => {
    const path = join(dir, 'missing-expect.json');
    const data = scenario();
    delete data['expect'];
    await writeFile(path, JSON.stringify(data));
    assert.deepEqual(await loadScenario(path), {
      ok: false,
      problem: 'expect is required',
    });
  });

  it('reports a file that is not JSON', async () => {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ "name": ');
    const result = await loadScenario(path);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.problem, /^not valid JSON: /);
  });

  it('reports a file that does not exist', async () => {
    const result = await loadScenario(join(dir, 'nope.json'));
    assert.equal(result.ok, false);
    assert.match(
      result.ok ? '' : result.problem,
      /^cannot read file: .*ENOENT/,
    );
  });
});
