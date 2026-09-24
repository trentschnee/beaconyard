import { readFile } from 'node:fs/promises';
// type-only on purpose: Node erases this line, so the tsconfig path alias
// never has to resolve at runtime (decisions/002-eval-runner.md)
import type { DeviceState, EventRecord } from '@beaconyard/contracts';

export type ScenarioMessage =
  | { topic: string; payload: unknown }
  | { topic: string; raw: string };

export interface ExpectedReject {
  topic: string;
  reasonStartsWith: string;
}

export interface ScenarioExpect {
  devices: DeviceState[];
  events: EventRecord[];
  rejects: ExpectedReject[];
}

export interface Scenario {
  name: string;
  description: string;
  messages: ScenarioMessage[];
  expect: ScenarioExpect;
}

export type Checked<T> =
  | { ok: true; value: T }
  | { ok: false; problem: string };

type FieldType = 'string' | 'number';

// `satisfies` keeps these in step with contracts: a field added to or removed
// from DeviceState or EventRecord breaks the typecheck until it's updated here.
// Only types are checked, not the api's value rules. A value the api would
// never store (battery 150, status "bogus") just fails the comparison.
const DEVICE_FIELDS = {
  deviceId: 'string',
  seq: 'number',
  ts: 'string',
  battery: 'number',
  status: 'string',
} as const satisfies Record<keyof DeviceState, FieldType>;

const EVENT_FIELDS = {
  deviceId: 'string',
  seq: 'number',
  ts: 'string',
  battery: 'number',
  status: 'string',
} as const satisfies Record<keyof EventRecord, FieldType>;

const REJECT_FIELDS = {
  topic: 'string',
  reasonStartsWith: 'string',
} as const satisfies Record<keyof ExpectedReject, FieldType>;

const SCENARIO_KEYS = ['name', 'description', 'messages', 'expect'];
const EXPECT_KEYS = ['devices', 'events', 'rejects'];
const MESSAGE_KEYS = ['topic', 'payload', 'raw'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingKey(
  obj: Record<string, unknown>,
  keys: readonly string[],
  where: string,
): string | undefined {
  const missing = keys.find((key) => !(key in obj));
  return missing === undefined ? undefined : `${where}${missing} is required`;
}

// unknown keys fail rather than get ignored, so a typo can't quietly turn an
// expectation off
function unknownKey(
  obj: Record<string, unknown>,
  keys: readonly string[],
  where: string,
): string | undefined {
  const extra = Object.keys(obj).find((key) => !keys.includes(key));
  return extra === undefined
    ? undefined
    : `${where} has unknown key "${extra}"`;
}

function checkList(
  value: unknown,
  where: string,
  checkItem: (item: unknown, where: string) => string | undefined,
): string | undefined {
  if (!Array.isArray(value)) {
    return `${where} must be an array`;
  }
  for (const [i, item] of value.entries()) {
    const problem = checkItem(item, `${where}[${i}]`);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

function checkMessage(value: unknown, where: string): string | undefined {
  if (!isObject(value)) {
    return `${where} must be an object`;
  }
  const topic = value['topic'];
  if (typeof topic !== 'string' || topic === '') {
    return `${where}.topic must be a non-empty string`;
  }
  // mqtt refuses to publish to a wildcard topic, so catch it here instead of
  // halfway through a run
  if (/[+#]/.test(topic)) {
    return `${where}.topic must not contain + or #`;
  }
  const hasPayload = 'payload' in value;
  const hasRaw = 'raw' in value;
  if (hasPayload === hasRaw) {
    return `${where} must have exactly one of payload or raw`;
  }
  if (hasRaw && typeof value['raw'] !== 'string') {
    return `${where}.raw must be a string`;
  }
  return unknownKey(value, MESSAGE_KEYS, where);
}

function docChecker(fields: Record<string, FieldType>) {
  return (value: unknown, where: string): string | undefined => {
    if (!isObject(value)) {
      return `${where} must be an object`;
    }
    for (const [key, type] of Object.entries(fields)) {
      if (!(key in value)) {
        return `${where} is missing ${key}`;
      }
      if (typeof value[key] !== type) {
        return `${where}.${key} must be a ${type}`;
      }
    }
    return unknownKey(value, Object.keys(fields), where);
  };
}

function nonEmptyString(value: unknown, key: string): string | undefined {
  return typeof value === 'string' && value !== ''
    ? undefined
    : `${key} must be a non-empty string`;
}

function findProblem(data: unknown): string | undefined {
  if (!isObject(data)) {
    return 'scenario must be a JSON object';
  }
  const topProblem =
    missingKey(data, SCENARIO_KEYS, '') ??
    nonEmptyString(data['name'], 'name') ??
    nonEmptyString(data['description'], 'description') ??
    checkList(data['messages'], 'messages', checkMessage);
  if (topProblem !== undefined) {
    return topProblem;
  }

  const expect = data['expect'];
  if (!isObject(expect)) {
    return 'expect must be an object';
  }
  return (
    missingKey(expect, EXPECT_KEYS, 'expect.') ??
    checkList(expect['devices'], 'expect.devices', docChecker(DEVICE_FIELDS)) ??
    checkList(expect['events'], 'expect.events', docChecker(EVENT_FIELDS)) ??
    checkList(expect['rejects'], 'expect.rejects', docChecker(REJECT_FIELDS)) ??
    unknownKey(expect, EXPECT_KEYS, 'expect') ??
    unknownKey(data, SCENARIO_KEYS, 'scenario')
  );
}

export function validateScenario(data: unknown): Checked<Scenario> {
  const problem = findProblem(data);
  // findProblem checked every field Scenario declares
  return problem === undefined
    ? { ok: true, value: data as Scenario }
    : { ok: false, problem };
}

export async function loadScenario(path: string): Promise<Checked<Scenario>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      problem: `cannot read file: ${(err as Error).message}`,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, problem: `not valid JSON: ${(err as Error).message}` };
  }
  return validateScenario(data);
}
