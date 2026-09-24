import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  API_MAIN,
  API_READY_TIMEOUT_MS,
  API_STOP_TIMEOUT_MS,
} from './config.mts';
import { RunnerError } from './infra.mts';

// what the api prints once it's connected (apps/api/src/mqtt/client.ts). It
// comes before the api subscribes, so the runner still probes after this.
const CONNECTED_LOG = 'mqtt connected';

// only the tail is worth keeping for a failure report
const OUTPUT_LIMIT = 64 * 1024;

export interface ApiProcess {
  // resolves on the api's first broker connection, rejects if it exits or
  // takes too long
  connected: Promise<void>;
  // what the api has printed so far, stdout and stderr interleaved
  output(): string;
  stop(): Promise<void>;
}

export function startApi(env: NodeJS.ProcessEnv): ApiProcess {
  const child = spawn(process.execPath, [API_MAIN], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Always drain both pipes. On Linux the api's console writes to a pipe are
  // synchronous, so a full pipe would block the api.
  let output = '';
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise<string>((resolve) => {
    child.once('exit', (code, signal) =>
      resolve(signal ?? `exit code ${code}`),
    );
    child.once('error', (err) => resolve(`failed to start: ${err.message}`));
  });

  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new RunnerError(
            `api did not connect to the broker within ${API_READY_TIMEOUT_MS} ms`,
          ),
        ),
      API_READY_TIMEOUT_MS,
    );
    // registered after append, so output already holds this chunk
    const onData = () => {
      if (output.includes(CONNECTED_LOG)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    void exited.then((how) => {
      clearTimeout(timer);
      reject(new RunnerError(`api exited (${how}) before it connected`));
    });
  });

  // last resort for exit paths that never reach stop()
  process.once('exit', () => {
    if (!hasExited()) {
      child.kill('SIGTERM');
    }
  });

  async function stop() {
    if (hasExited()) {
      return;
    }
    // the api shuts down cleanly on SIGTERM (apps/api/src/main.ts)
    child.kill('SIGTERM');
    const done = await Promise.race([
      exited.then(() => true),
      sleep(API_STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!done) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  return { connected, output: () => output, stop };
}
