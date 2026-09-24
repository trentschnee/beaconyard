import { TestBed } from '@angular/core/testing';
import type { DeviceState } from '@beaconyard/contracts';
import { DevicesStore } from './devices-store';

// battery follows seq so a test can tell which copy is shown
const dev = (deviceId: string, seq: number, battery = seq): DeviceState => ({
  deviceId,
  seq,
  ts: `2026-09-24T10:00:${String(seq).padStart(2, '0')}Z`,
  battery,
  status: 'ok',
});

let store: DevicesStore;

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [DevicesStore] });
  store = TestBed.inject(DevicesStore);
});

describe('DevicesStore', () => {
  it('S04-AT8: a snapshot replaces the whole list, dropping devices not in it', () => {
    store.applySnapshot([dev('a', 5), dev('b', 3)]);
    store.applyUpdate(dev('z', 1));

    // a comes back with a lower seq, e.g. after the api's database was reset
    store.applySnapshot([dev('a', 2), dev('c', 1)]);

    expect(store.rows()).toEqual([dev('a', 2), dev('c', 1)]);
  });

  it('S04-AT8: after a snapshot, an update with an equal or lower seq keeps what is shown', () => {
    store.applySnapshot([dev('a', 5)]);

    store.applyUpdate(dev('a', 4));
    // same seq, different body
    store.applyUpdate(dev('a', 5, 99));

    expect(store.rows()).toEqual([dev('a', 5)]);
  });

  it('S04-AT8: after a snapshot, an update with a higher seq replaces the row', () => {
    store.applySnapshot([dev('a', 5), dev('b', 1)]);

    store.applyUpdate(dev('a', 6));

    expect(store.rows()).toEqual([dev('a', 6), dev('b', 1)]);
  });

  it('S04-AT8: after a snapshot, an update for a new device ID adds a row', () => {
    store.applySnapshot([dev('b', 5)]);

    store.applyUpdate(dev('a', 1));

    expect(store.rows()).toEqual([dev('a', 1), dev('b', 5)]);
  });

  it('sorts rows by device ID in plain string order', () => {
    store.applySnapshot([dev('dev-2', 1), dev('dev-10', 1), dev('dev-1', 1)]);

    expect(store.rows().map((d) => d.deviceId)).toEqual([
      'dev-1',
      'dev-10',
      'dev-2',
    ]);
  });
});
