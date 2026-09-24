import type { DeviceStatus } from './heartbeat';

// `devices` collection: current state, one document per device
export interface DeviceState {
  deviceId: string;
  seq: number;
  ts: string;
  battery: number;
  status: DeviceStatus;
}

// `events` collection: every unique heartbeat, live or replayed. Unique on
// deviceId + seq. No server timestamps; ts is the device's event time.
export interface EventRecord {
  deviceId: string;
  seq: number;
  ts: string;
  battery: number;
  status: DeviceStatus;
}

// a device with no alert history counts as armed
export type LowBatteryState = 'armed' | 'alerted';

// `alertStates` collection: one document per device, unique on deviceId
export interface AlertState {
  deviceId: string;
  // the last seq the low-battery rule applied
  seq: number;
  lowBattery: LowBatteryState;
}

// `rejects` collection: messages that failed validation
export interface RejectedMessage {
  topic: string;
  // raw payload decoded as UTF-8
  payload: string;
  reason: string;
  // server clock, for debugging only; never used for ordering
  receivedAt: Date;
}
