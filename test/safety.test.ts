import assert from "node:assert/strict";
import test from "node:test";
import { SafetyController } from "../src/safety.js";
import type { LovenseDeviceInfo, ToyDevice } from "../src/types.js";

const ferri: ToyDevice = {
  id: "ferri-1", name: "Ferri", toyType: "ferri", nickname: "", battery: 80, connected: true,
  capabilities: ["Vibrate"], capabilitySource: "catalog",
};
const vulse: ToyDevice = {
  id: "vulse-1", name: "Vulse", toyType: "vulse", nickname: "", battery: 70, connected: true,
  capabilities: ["Vibrate", "Thrusting"], capabilitySource: "catalog",
};
const devices: LovenseDeviceInfo = {
  online: true, appType: "remote", appVersion: "7.71.0", platform: "ios", updatedAt: new Date().toISOString(), toys: [ferri, vulse],
};

test("works whenever Lovense Remote and the device are connected", () => {
  const safety = new SafetyController({ maxCommandSeconds: 3600 });
  const result = safety.validateControl([{ function: "Vibrate", intensity: 5 }], 5, [ferri.id], devices);
  assert.equal(result.action, "Vibrate:5");
  assert.deepEqual(result.targetIds, [ferri.id]);
});

test("supports an explicitly named multi-device group", () => {
  const safety = new SafetyController({ maxCommandSeconds: 3600 });
  const result = safety.validateControl([{ function: "Vibrate", intensity: 20 }], 8, [ferri.id, vulse.id], devices);
  assert.deepEqual(result.targetIds, [ferri.id, vulse.id]);
});

test("rejects unsupported functions and disconnected devices", () => {
  const safety = new SafetyController({ maxCommandSeconds: 3600 });
  assert.throws(
    () => safety.validateControl([{ function: "Thrusting", intensity: 8 }], 5, [ferri.id], devices),
    /does not support Thrusting/,
  );
  assert.throws(
    () => safety.validateControl([{ function: "Vibrate", intensity: 8 }], 5, ["missing"], devices),
    /not connected/,
  );
});

test("supports indefinite commands only through duration zero", () => {
  const safety = new SafetyController({ maxCommandSeconds: 3600 });
  assert.equal(safety.validateControl([{ function: "Vibrate", intensity: 10 }], 0, [ferri.id], devices).durationSeconds, 0);
  assert.throws(() => safety.validateControl([{ function: "Vibrate", intensity: 10 }], 1, [ferri.id], devices), /0.*or between 2/i);
});

test("validates stroke range", () => {
  const strokeToy = { ...vulse, capabilities: ["Thrusting", "Stroke"] as const } as ToyDevice;
  const strokeDevices = { ...devices, toys: [strokeToy] };
  const safety = new SafetyController({ maxCommandSeconds: 3600 });
  assert.throws(
    () => safety.validateControl([{ function: "Stroke", strokeMin: 20, strokeMax: 30 }], 5, [strokeToy.id], strokeDevices),
    /at least 20/,
  );
  assert.equal(
    safety.validateControl([{ function: "Stroke", strokeMin: 10, strokeMax: 60 }], 5, [strokeToy.id], strokeDevices).action,
    "Stroke:10-60",
  );
});
