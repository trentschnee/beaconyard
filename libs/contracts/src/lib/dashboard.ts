import type { DeviceState } from './documents';

// api -> browser over /ws/devices. A client gets one snapshot first, then a
// device message after every write that changed that device's state.
export interface SnapshotMessage {
  type: 'snapshot';
  devices: DeviceState[];
}

export interface DeviceMessage {
  type: 'device';
  device: DeviceState;
}

export type DashboardMessage = SnapshotMessage | DeviceMessage;
