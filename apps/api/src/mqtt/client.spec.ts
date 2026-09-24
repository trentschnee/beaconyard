import { EventEmitter } from 'node:events';
import type { ClientSubscribeCallback, MqttClient } from 'mqtt';
import { startMqtt } from './client';

const URL = 'mqtt://broker.test:1883';
const TOPIC = 'devices/+/heartbeat';

// just enough of MqttClient for startMqtt: events plus subscribe
class FakeMqttClient extends EventEmitter {
  subscribe = jest.fn();
}

function setup() {
  const fake = new FakeMqttClient();
  const connectFn = jest.fn((): MqttClient => fake as unknown as MqttClient);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const onHeartbeat = jest.fn(() => Promise.resolve());
  startMqtt(URL, logger, onHeartbeat, connectFn);
  return { fake, connectFn, logger, onHeartbeat };
}

function subscribeCallback(fake: FakeMqttClient): ClientSubscribeCallback {
  const call = fake.subscribe.mock.lastCall;
  if (!call) {
    throw new Error('subscribe was never called');
  }
  return call[2];
}

describe('startMqtt', () => {
  it('subscribes on every successful connect', () => {
    const { fake } = setup();
    expect(fake.subscribe).not.toHaveBeenCalled();

    fake.emit('connect');
    fake.emit('connect');

    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    for (const n of [1, 2]) {
      expect(fake.subscribe).toHaveBeenNthCalledWith(
        n,
        TOPIC,
        { qos: 1 },
        expect.any(Function),
      );
    }
  });

  it('turns off the library resubscribe', () => {
    const { connectFn } = setup();

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(connectFn).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ resubscribe: false }),
    );
  });

  it('logs a failed subscribe at error level', () => {
    const { fake, logger } = setup();
    fake.emit('connect');
    const err = Object.assign(new Error('Subscribe error: Not authorized'), {
      code: 135,
    });

    subscribeCallback(fake)(err);

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topic: TOPIC, err }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a warning with the granted qos when the broker downgrades', () => {
    const { fake, logger } = setup();
    fake.emit('connect');

    subscribeCallback(fake)(null, [{ topic: TOPIC, qos: 0 }]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topic: TOPIC, grantedQos: 0 }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('stays quiet when the requested qos is granted', () => {
    const { fake, logger } = setup();
    fake.emit('connect');

    subscribeCallback(fake)(null, [{ topic: TOPIC, qos: 1 }]);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('forwards messages to the heartbeat handler', () => {
    const { fake, onHeartbeat } = setup();
    const payload = Buffer.from('{"seq":1}');

    fake.emit('message', 'devices/dev-1/heartbeat', payload);

    expect(onHeartbeat).toHaveBeenCalledWith(
      'devices/dev-1/heartbeat',
      payload,
    );
  });
});
