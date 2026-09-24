import type { DeviceState } from '@beaconyard/contracts';
import type { LowBatteryRule } from './alerts/low-battery';
import type { DashboardHub } from './ws/dashboard';

export interface DeviceChangedDeps {
  // only there when DASHBOARD_ENABLED is on
  dashboard?: Pick<DashboardHub, 'publish'>;
  lowBattery: Pick<LowBatteryRule, 'evaluate'>;
}

// The handlers' onDeviceChanged. The alert rule goes first and isn't awaited,
// so ingest never waits on Mongo or the broker for it, and a dashboard throw
// can't skip it. That throw still reaches the handler, which logs it as before.
export function createDeviceChangedListener({
  dashboard,
  lowBattery,
}: DeviceChangedDeps): (state: DeviceState) => void {
  return (state) => {
    // evaluate never rejects
    void lowBattery.evaluate(state);
    dashboard?.publish(state);
  };
}
