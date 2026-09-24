// api -> alerts/{deviceId}, QoS 1, not retained. Every field comes from the
// state that triggered it, and deviceId + seq identify the alert, so a
// consumer can drop a second copy.
export interface LowBatteryAlert {
  type: 'low-battery';
  deviceId: string;
  seq: number;
  ts: string;
  battery: number;
}
