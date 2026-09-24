import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Db } from 'mongodb';
import type { MqttClient } from 'mqtt';
import { startApi, type ApiProcess } from './api-process.mts';
import {
  compareState,
  formatMismatches,
  type ActualState,
  type Mismatch,
} from './compare.mts';
import {
  API_READY_TIMEOUT_MS,
  apiEnv,
  COLLECTIONS,
  EVAL_DB,
  loadConfig,
  MATCH_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PROBE_ATTEMPT_MS,
  PROBE_DEVICE_ID,
  REPO_ROOT,
  SCENARIO_DIR,
  SETTLE_MS,
} from './config.mts';
import { clearSession, connectInfra, RunnerError } from './infra.mts';
import { loadScenario, type Checked, type Scenario } from './schema.mts';

const USAGE = 'usage: pnpm run eval [-- <scenario file>]';

interface ScenarioFile {
  label: string;
  loaded: Checked<Scenario>;
}

type Outcome =
  | { passed: true }
  | { passed: false; note: string; mismatches: Mismatch[] };

// the api child, for the signal handlers
let runningApi: ApiProcess | undefined;

async function scenarioPaths(argv: readonly string[]): Promise<string[]> {
  // pnpm hands a literal "--" through to the script
  const args = argv.filter((arg) => arg !== '--');
  if (args.length > 1) {
    throw new RunnerError(USAGE);
  }
  if (args.length === 1) {
    // pnpm runs scripts from the repo root, INIT_CWD is where the user was
    return [resolve(process.env['INIT_CWD'] ?? process.cwd(), args[0])];
  }
  const names = (await readdir(SCENARIO_DIR))
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (names.length === 0) {
    throw new RunnerError(
      `no scenarios in ${relative(REPO_ROOT, SCENARIO_DIR)}`,
    );
  }
  return names.map((name) => resolve(SCENARIO_DIR, name));
}

// Through npx so it works with or without pnpm's .bin on PATH. Build output
// goes to stderr so stdout is just the PASS/FAIL report.
async function buildApi(): Promise<void> {
  const child = spawn('npx', ['nx', 'build', 'api'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) {
    throw new RunnerError(`api build failed (exit code ${code})`);
  }
}

// deleteMany rather than drop, so the api's unique indexes stay in place
async function clearEvalData(db: Db): Promise<void> {
  await Promise.all(
    COLLECTIONS.map((name) => db.collection(name).deleteMany({})),
  );
}

async function readState(db: Db): Promise<ActualState> {
  const read = (name: (typeof COLLECTIONS)[number]) =>
    db.collection(name).find().toArray();
  const [devices, events, rejects] = await Promise.all([
    read('devices'),
    read('events'),
    read('rejects'),
  ]);
  return { devices, events, rejects };
}

// The api logs "mqtt connected" before it subscribes, and the broker drops a
// message that arrives before the subscription. A probe heartbeat reaching
// the events collection proves the subscriptions are live. One the broker
// dropped never shows up, so after a while send the next seq. The first
// scenario's clear removes the probe.
async function waitUntilSubscribed(mqtt: MqttClient, db: Db): Promise<void> {
  const events = db.collection('events');
  const deadline = Date.now() + API_READY_TIMEOUT_MS;
  for (let seq = 1; Date.now() < deadline; seq++) {
    const probe = {
      seq,
      ts: '2000-01-01T00:00:00Z',
      battery: 100,
      status: 'ok',
    };
    await mqtt.publishAsync(
      `devices/${PROBE_DEVICE_ID}/heartbeat`,
      JSON.stringify(probe),
      { qos: 1 },
    );
    const attemptEnd = Math.min(Date.now() + PROBE_ATTEMPT_MS, deadline);
    while (Date.now() < attemptEnd) {
      if ((await events.countDocuments({ deviceId: PROBE_DEVICE_ID })) > 0) {
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new RunnerError(
    `api connected, but no probe heartbeat reached ${EVAL_DB} within ${API_READY_TIMEOUT_MS} ms`,
  );
}

async function playScenario(
  scenario: Scenario,
  mqtt: MqttClient,
  db: Db,
): Promise<Outcome> {
  await clearEvalData(db);
  for (const message of scenario.messages) {
    const body =
      'raw' in message ? message.raw : JSON.stringify(message.payload);
    // resolves on the broker's PUBACK
    await mqtt.publishAsync(message.topic, body, { qos: 1 });
  }

  const check = async () => compareState(scenario.expect, await readState(db));
  const deadline = Date.now() + MATCH_TIMEOUT_MS;
  let mismatches = await check();
  while (mismatches.length > 0) {
    if (Date.now() >= deadline) {
      return {
        passed: false,
        note: `no match within ${MATCH_TIMEOUT_MS} ms`,
        mismatches,
      };
    }
    await sleep(POLL_INTERVAL_MS);
    mismatches = await check();
  }

  // a late extra write lands after the first match, so look once more
  await sleep(SETTLE_MS);
  mismatches = await check();
  if (mismatches.length > 0) {
    return {
      passed: false,
      note: `matched, then changed within ${SETTLE_MS} ms`,
      mismatches,
    };
  }
  return { passed: true };
}

function printInvalid({ label, loaded }: ScenarioFile): void {
  if (!loaded.ok) {
    console.log(`FAIL ${label}`);
    console.log(`  invalid scenario: ${loaded.problem}`);
  }
}

async function main(): Promise<number> {
  const config = loadConfig();
  const files: ScenarioFile[] = [];
  for (const path of await scenarioPaths(process.argv.slice(2))) {
    files.push({
      label: relative(REPO_ROOT, path),
      loaded: await loadScenario(path),
    });
  }

  // nothing to play, so don't make the user start infra just to hear that
  if (!files.some((file) => file.loaded.ok)) {
    files.forEach(printInvalid);
    return 1;
  }

  const infra = await connectInfra(config);
  let api: ApiProcess | undefined;
  let allPassed = false;
  try {
    await buildApi();
    await clearSession(config.mqttUrl);
    api = runningApi = startApi(apiEnv(config));
    await api.connected;

    const db = infra.mongo.db(EVAL_DB);
    // a run that died before its first scenario can leave an old probe behind
    await clearEvalData(db);
    await waitUntilSubscribed(infra.mqtt, db);

    let failures = 0;
    for (const file of files) {
      if (!file.loaded.ok) {
        printInvalid(file);
        failures++;
        continue;
      }
      const scenario = file.loaded.value;
      const outcome = await playScenario(scenario, infra.mqtt, db);
      if (outcome.passed) {
        console.log(`PASS ${scenario.name}`);
      } else {
        console.log(`FAIL ${scenario.name}`);
        console.log(`  ${outcome.note}`);
        for (const line of formatMismatches(outcome.mismatches)) {
          console.log(line);
        }
        failures++;
      }
    }
    allPassed = failures === 0;
    return allPassed ? 0 : 1;
  } finally {
    if (api && !allPassed) {
      console.error('\napi output:');
      console.error(api.output());
    }
    await api?.stop();
    runningApi = undefined;
    await Promise.all([infra.mqtt.endAsync(), infra.mongo.close()]);
  }
}

// Ctrl+C: stop the api before leaving. The api gets the terminal's SIGINT as
// well, and stop() is a no-op once it has exited.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.once(signal, () => {
    void (runningApi?.stop() ?? Promise.resolve()).finally(() =>
      process.exit(code),
    );
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof RunnerError ? err.message : err);
    process.exit(1);
  },
);
