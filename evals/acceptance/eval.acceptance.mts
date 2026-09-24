// Spec 03 acceptance tests 1-8. They run `pnpm run eval` the way a person
// would, so they need the local infra (docker compose up -d) and must not run
// in parallel: every run shares the beaconyard-eval client ID and database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { MongoClient } from 'mongodb';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MONGO_URL = process.env['EVAL_MONGO_URL'] || 'mongodb://localhost:27017';
// spec 03's limit, not imported from the runner so a change there can't
// quietly relax the test
const INFRA_LIMIT_MS = 10_000;

interface EvalRun {
  code: number | null;
  stdout: string;
  // stdout and stderr together, for messages and failure output
  output: string;
  ms: number;
}

interface PartReport {
  expected: string[];
  actual: string[];
}

function runEval(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<EvalRun> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(
      'pnpm',
      ['run', 'eval', ...(args.length > 0 ? ['--', ...args] : [])],
      { cwd: REPO_ROOT, env: { ...process.env, ...env } },
    );
    let stdout = '';
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) =>
      resolvePromise({ code, stdout, output, ms: Date.now() - started }),
    );
  });
}

// absolute, so the runner doesn't depend on INIT_CWD from whoever started us
function selfTest(file: string): string {
  return resolve(REPO_ROOT, 'evals/self-test', file);
}

function resultLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => /^(PASS|FAIL) /.test(line));
}

// the indented block under "FAIL <name>", by part
function failReport(stdout: string, name: string): Map<string, PartReport> {
  const lines = stdout.split('\n');
  const start = lines.indexOf(`FAIL ${name}`);
  assert.notEqual(start, -1, `no "FAIL ${name}" line in:\n${stdout}`);

  const parts = new Map<string, PartReport>();
  let part: PartReport | undefined;
  let list: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) {
      break;
    }
    const header = /^ {2}(devices|events|rejects):$/.exec(line);
    if (header) {
      part = { expected: [], actual: [] };
      parts.set(header[1], part);
    } else if (line === '    expected:') {
      list = part?.expected;
    } else if (line === '    actual:') {
      list = part?.actual;
    } else if (line.startsWith('      ') && line.trim() !== '(none)') {
      // "(none)" is how the runner prints an empty list
      list?.push(line.trim());
    }
  }
  return parts;
}

async function beaconyardCounts(): Promise<Record<string, number>> {
  const client = await MongoClient.connect(MONGO_URL);
  try {
    // read only: the runner must never write here
    const db = client.db('beaconyard');
    const counts: Record<string, number> = {};
    const collections = await db
      .listCollections({}, { nameOnly: true })
      .toArray();
    for (const { name } of collections) {
      counts[name] = await db.collection(name).countDocuments();
    }
    return counts;
  } finally {
    await client.close();
  }
}

// a port nothing listens on, which is what a stopped container looks like
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function assertFailsOnlyOn(run: EvalRun, name: string, part: string): void {
  assert.deepEqual(resultLines(run.stdout), [`FAIL ${name}`], run.output);
  assert.deepEqual([...failReport(run.stdout, name).keys()], [part]);
  assert.equal(run.code, 1);
}

describe('pnpm run eval', () => {
  describe('two full runs in a row', () => {
    let countsBefore: Record<string, number>;
    let first: EvalRun;
    let second: EvalRun;
    let countsAfter: Record<string, number>;

    before(async () => {
      countsBefore = await beaconyardCounts();
      first = await runEval();
      second = await runEval();
      countsAfter = await beaconyardCounts();
    });

    it('AT 1: prints PASS for clean, duplicates and out-of-order, and exits 0', () => {
      assert.deepEqual(
        resultLines(first.stdout),
        ['PASS clean', 'PASS duplicates', 'PASS out-of-order'],
        first.output,
      );
      assert.equal(first.code, 0);
    });

    it('AT 5: gives the same result the second time', () => {
      assert.deepEqual(resultLines(second.stdout), resultLines(first.stdout));
      assert.equal(second.code, first.code);
    });

    it('AT 6: leaves the document counts in beaconyard unchanged', () => {
      assert.deepEqual(countsAfter, countsBefore);
    });
  });

  it('AT 2: a wrong battery fails on devices and shows expected and actual', async () => {
    const run = await runEval([selfTest('wrong-battery.json')]);
    assertFailsOnlyOn(run, 'wrong-battery', 'devices');
    const devices = failReport(run.stdout, 'wrong-battery').get('devices');
    assert.equal(devices?.expected.length, 1);
    assert.match(devices?.expected[0] ?? '', /"battery":80/);
    assert.equal(devices?.actual.length, 1);
    assert.match(devices?.actual[0] ?? '', /"battery":90/);
  });

  it('AT 3: an expected event that never happens fails on events', async () => {
    const run = await runEval([selfTest('missing-event.json')]);
    assertFailsOnlyOn(run, 'missing-event', 'events');
  });

  it('AT 3: an expected reject that never happens fails on rejects', async () => {
    const run = await runEval([selfTest('missing-reject.json')]);
    assertFailsOnlyOn(run, 'missing-reject', 'rejects');
  });

  it('AT 4: a malformed message fails a scenario that expects no rejects', async () => {
    const run = await runEval([selfTest('unexpected-reject.json')]);
    assertFailsOnlyOn(run, 'unexpected-reject', 'rejects');
    const rejects = failReport(run.stdout, 'unexpected-reject').get('rejects');
    assert.deepEqual(rejects?.expected, []);
    assert.equal(rejects?.actual.length, 1);
  });

  it('AT 7: with the broker down, exits non-zero within 10 s and says how to start it', async () => {
    const run = await runEval([], {
      EVAL_MQTT_URL: `mqtt://127.0.0.1:${await closedPort()}`,
    });
    assert.notEqual(run.code, 0);
    assert.ok(run.ms < INFRA_LIMIT_MS, `took ${run.ms} ms`);
    assert.match(run.output, /broker/);
    assert.doesNotMatch(run.output, /Mongo/);
    assert.ok(run.output.includes('docker compose up -d'), run.output);
  });

  it('Behavior 2: with Mongo down, exits non-zero within 10 s and names Mongo', async () => {
    const run = await runEval([], {
      EVAL_MONGO_URL: `mongodb://127.0.0.1:${await closedPort()}`,
    });
    assert.notEqual(run.code, 0);
    assert.ok(run.ms < INFRA_LIMIT_MS, `took ${run.ms} ms`);
    assert.match(run.output, /Mongo/);
    assert.doesNotMatch(run.output, /broker/);
    assert.ok(run.output.includes('docker compose up -d'), run.output);
  });

  it('AT 8: a scenario missing expect fails, naming the file and expect', async () => {
    // infra pointed nowhere: schema problems are reported before infra is needed
    const port = await closedPort();
    const run = await runEval([selfTest('missing-expect.json')], {
      EVAL_MQTT_URL: `mqtt://127.0.0.1:${port}`,
      EVAL_MONGO_URL: `mongodb://127.0.0.1:${port}`,
    });
    const label = 'evals/self-test/missing-expect.json';
    assert.deepEqual(resultLines(run.stdout), [`FAIL ${label}`], run.output);
    assert.ok(
      run.stdout.includes('invalid scenario: expect is required'),
      run.output,
    );
    assert.equal(run.code, 1);
  });
});
