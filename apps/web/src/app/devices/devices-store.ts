import { computed, Injectable, signal } from '@angular/core';
import type { DeviceState } from '@beaconyard/contracts';

// plain code-unit order, the same in every locale: dev-10 sorts before dev-2
function byDeviceId(a: DeviceState, b: DeviceState): number {
  if (a.deviceId === b.deviceId) {
    return 0;
  }
  return a.deviceId < b.deviceId ? -1 : 1;
}

// What the dashboard shows, one entry per device.
@Injectable()
export class DevicesStore {
  private readonly byId = signal<ReadonlyMap<string, DeviceState>>(new Map());

  readonly rows = computed(() => [...this.byId().values()].sort(byDeviceId));

  // A snapshot is the api's whole current state, so it replaces everything
  // shown, including devices it no longer lists and higher seqs we had.
  applySnapshot(devices: readonly DeviceState[]): void {
    this.byId.set(new Map(devices.map((d) => [d.deviceId, d])));
  }

  // seq alone decides (decisions/001-message-id.md). Updates can arrive older
  // than what's shown, e.g. one queued while the snapshot was being read.
  applyUpdate(device: DeviceState): void {
    const shown = this.byId().get(device.deviceId);
    if (shown && shown.seq >= device.seq) {
      return;
    }
    this.byId.update((current) =>
      new Map(current).set(device.deviceId, device),
    );
  }
}
