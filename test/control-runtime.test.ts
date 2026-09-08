import assert from "node:assert/strict";
import test from "node:test";
import { ControlRuntime } from "../src/control-runtime.js";
import { SafetyController } from "../src/safety.js";
import type { LovenseDeviceInfo } from "../src/types.js";

const deviceInfo: LovenseDeviceInfo = {
  online: true,
  appType: "remote",
  appVersion: "test",
  platform: "test",
  updatedAt: new Date().toISOString(),
  toys: [{
    id: "lush-1",
    name: "Lush 4",
    toyType: "lush",
    nickname: "BLACKVOW",
    battery: 97,
    connected: true,
    capabilities: ["Vibrate"],
    capabilitySource: "catalog",
  }],
};

function harness(maxCommandSeconds = 3600) {
  const commands: Array<{ command: Record<string, unknown>; targetIds: string[] }> = [];
  const client = {
    status: () => ({ connectionState: "connected", lastError: "", deviceInfo }),
    sendCommand: (command: Record<string, unknown>, targetIds: string[]) => commands.push({ command, targetIds }),
  };
  const limits = { maxCommandSeconds };
  const runtime = new ControlRuntime(client as never, new SafetyController(limits), limits);
  return { runtime, commands };
}

test("relative adjustment uses BLACKVOW's last explicit level", () => {
  const { runtime, commands } = harness();
  runtime.control([{ function: "Vibrate", intensity: 10 }], 0, ["lush-1"]);
  const result = runtime.adjust([{ function: "Vibrate", delta: 4 }], ["lush-1"], 0);
  assert.equal(result.resultingActions[0]?.action, "Vibrate:14");
  assert.equal(commands[1]?.command.action, "Vibrate:14");
  runtime.close();
});

test("relative adjustment clamps to the native device range", () => {
  const { runtime } = harness();
  runtime.control([{ function: "Vibrate", intensity: 18 }], 0, ["lush-1"]);
  assert.equal(runtime.adjust([{ function: "Vibrate", delta: 9 }], ["lush-1"], 0).resultingActions[0]?.action, "Vibrate:20");
  runtime.close();
});

test("relative adjustment refuses to guess an unknown current level", () => {
  const { runtime } = harness();
  assert.throws(() => runtime.adjust([{ function: "Vibrate", delta: 2 }], ["lush-1"], 0), /current Vibrate level is unknown/);
  runtime.close();
});

test("routine validates every phase before starting and returns immediately", () => {
  const { runtime, commands } = harness(60);
  const result = runtime.startRoutine([
    { actions: [{ function: "Vibrate", intensity: 6 }], durationSeconds: 2 },
    { actions: [{ function: "Vibrate", intensity: 12 }], durationSeconds: 3 },
  ], 2, ["lush-1"]);
  assert.equal(result.totalDurationSeconds, 10);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.command.action, "Vibrate:6");
  runtime.close();
});

test("routine rejects an aggregate duration beyond the configured ceiling", () => {
  const { runtime, commands } = harness(10);
  assert.throws(() => runtime.startRoutine([
    { actions: [{ function: "Vibrate", intensity: 6 }], durationSeconds: 6 },
  ], 2, ["lush-1"]), /complete routine.*10 seconds/);
  assert.equal(commands.length, 0);
  runtime.close();
});
