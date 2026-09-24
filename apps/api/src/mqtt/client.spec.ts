import { EventEmitter } from 'node:events';
import type { ClientSubscribeCallback, MqttClient } from 'mqtt';
import { startMqtt } from './client';

const URL = 'mqtt://broker.test:1883';
const CLIENT_ID = 'test-id';
const HEARTBEAT = 'devices/+/heartbeat';
const REPLAY = 'devices/+/replay';

// just enough of MqttClient for startMqtt: events plus subscribe
class FakeMqttClient extends EventEmitter {
  subscribe = jest.fn();
}

function setup() {
  const fake = new FakeMqttClient();
  const connectFn = jest.fn((): MqttClient => fake as unknown as MqttClient);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const onHeartbeat = jest.fn(() => Promise.resolve());
  const onReplay = jest.fn(() => Promise.resolve());
  startMqtt(
    { url: URL, clientId: CLIENT_ID },
    logger,
    { [HEARTBEAT]: onHeartbeat, [REPLAY]: onReplay },
    connectFn,
  );
  return { fake, connectFn, logger, onHeartbeat, onReplay };
}

// callback from the latest subscribe for this topic
function subscribeCallback(
  fake: FakeMqttClient,
  topic: string,
): ClientSubscribeCallback {
  const calls = fake.subscribe.mock.calls.filter(
    ([t]: [string]) => t === topic,
  );
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(`subscribe was never called for ${topic}`);
  }
  return call[2];
}

describe('startMqtt', () => {
  it('S02-AT10: subscribes to both topics at qos 1 on every successful connect', () => {
    const { fake } = setup();
    expect(fake.subscribe).not.toHaveBeenCalled();

    fake.emit('connect');
    fake.emit('connect');

    expect(fake.subscribe).toHaveBeenCalledTimes(4);
    expect(
      fake.subscribe.mock.calls.map(([topic, opts]) => [topic, opts]),
    ).toEqual([
      [HEARTBEAT, { qos: 1 }],
      [REPLAY, { qos: 1 }],
      [HEARTBEAT, { qos: 1 }],
      [REPLAY, { qos: 1 }],
    ]);
  });

  it('S02-AT10: connects with the configured client ID and a persistent session', () => {
    const { connectFn } = setup();

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(connectFn).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ clientId: CLIENT_ID, clean: false }),
    );
  });

  it('turns off the library resubscribe', () => {
    const { connectFn } = setup();

    expect(connectFn).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ resubscribe: false }),
    );
  });

  it.each([HEARTBEAT, REPLAY])(
    'logs a failed subscribe to %s at error level',
    (topic) => {
      const { fake, logger } = setup();
      fake.emit('connect');
      const err = Object.assign(new Error('Subscribe error: Not authorized'), {
        code: 135,
      });

      subscribeCallback(fake, topic)(err);

      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ topic, err }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('logs a warning with the granted qos when the broker downgrades', () => {
    const { fake, logger } = setup();
    fake.emit('connect');

    subscribeCallback(fake, REPLAY)(null, [{ topic: REPLAY, qos: 0 }]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topic: REPLAY, grantedQos: 0 }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('stays quiet when the requested qos is granted', () => {
    const { fake, logger } = setup();
    fake.emit('connect');

    subscribeCallback(fake, HEARTBEAT)(null, [{ topic: HEARTBEAT, qos: 1 }]);
    subscribeCallback(fake, REPLAY)(null, [{ topic: REPLAY, qos: 1 }]);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('S02-AT10: routes heartbeat messages to the heartbeat handler only', () => {
    const { fake, onHeartbeat, onReplay } = setup();
    const payload = Buffer.from('{"seq":1}');

    fake.emit('message', 'devices/dev-1/heartbeat', payload);

    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onHeartbeat).toHaveBeenCalledWith(
      'devices/dev-1/heartbeat',
      payload,
    );
    expect(onReplay).not.toHaveBeenCalled();
  });

  it.each(['devices/dev-1/replay', 'devices//replay'])(
    'S02-AT10: routes %s to the replay handler only',
    (topic) => {
      const { fake, onHeartbeat, onReplay } = setup();
      const payload = Buffer.from('[]');

      fake.emit('message', topic, payload);

      expect(onReplay).toHaveBeenCalledTimes(1);
      expect(onReplay).toHaveBeenCalledWith(topic, payload);
      expect(onHeartbeat).not.toHaveBeenCalled();
    },
  );

  it.each([
    'devices/dev-1/status',
    'devices/a/b/replay',
    'sensors/dev-1/replay',
  ])('warns and drops %s, which no handler matches', (topic) => {
    const { fake, logger, onHeartbeat, onReplay } = setup();

    fake.emit('message', topic, Buffer.from('[]'));

    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onReplay).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topic }),
    );
  });
});
