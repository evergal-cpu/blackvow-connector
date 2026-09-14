import assert from "node:assert/strict";
import test from "node:test";
import { EnsembleRuntime } from "../src/ensemble-runtime.js";
import type { LovenseDeviceInfo } from "../src/types.js";

function harness() {
  const deviceInfo: LovenseDeviceInfo = {
    online: true, appType: "remote", appVersion: "test", platform: "test", updatedAt: new Date().toISOString(),
    toys: [
      { id: "lush-1", name: "Lush 4", toyType: "lush", nickname: "BLACKVOW", battery: 90, connected: true, capabilities: ["Vibrate"], capabilitySource: "device" },
      { id: "spinel-1", name: "Spinel", toyType: "spinel", nickname: "Spinel", battery: 82, connected: true, capabilities: ["Vibrate", "Thrusting"], capabilitySource: "device" },
    ],
  };
  const commands: Array<{ command: Record<string, unknown>; targetIds: string[] }> = [];
  let nextFailure: Error | null = null;
  const client = {
    status: () => ({ connectionState: "connected", lastError: "", deviceInfo }),
    sendCommand: (command: Record<string, unknown>, targetIds: string[]) => {
      if (nextFailure) {
        const error = nextFailure;
        nextFailure = null;
        throw error;
      }
      commands.push({ command, targetIds });
    },
  };
  return {
    runtime: new EnsembleRuntime(client as never, { maxCommandSeconds: 7200 }),
    commands,
    deviceInfo,
    failNext: (message = "mock dispatch failure") => { nextFailure = new Error(message); },
  };
}

test("discovery distinguishes Lush and Spinel with announced channels", () => {
  const { runtime } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  const devices = runtime.listDevices();
  assert.deepEqual(devices.map((device) => device.alias), ["lush", "spinel"]);
  assert.deepEqual(devices[1]?.supportedChannels, ["Vibrate", "Thrusting"]);
  assert.deepEqual(devices[1]?.apiChannels, ["Vibrate", "Thrusting"]);
  assert.deepEqual(devices[1]?.verificationState, {
    apiChannels: "announced",
    physicalDelivery: "not_recorded_by_connector",
  });
  assert.deepEqual((devices[1]?.manualOrAppFeatures as Array<Record<string, unknown>>).map((entry) => [
    entry.feature, entry.blackvowControllable, entry.availableForCurrentAttachment,
  ]), [
    ["Heat", false, true],
    ["Turbo", false, null],
  ]);
  runtime.close();
});

test("live-session plans never exceed the two-hour ceiling", () => {
  const { runtime } = harness();
  assert.throws(() => runtime.preview({
    durationSeconds: 7201,
    tracks: [{ device: "lush", steps: [{ actions: [{ function: "Vibrate", intensity: 1 }], holdSeconds: 2 }] }],
  }), /7200 seconds/);
  runtime.close();
});

test("Spinel requires an attachment and g_curve rejects vibration", () => {
  const { runtime } = harness();
  assert.throws(() => runtime.preview({ durationSeconds: 10, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Thrusting", intensity: 10 }], holdSeconds: 5 }] }] }), /attachment profile/);
  runtime.configureProfile({ device: "spinel", attachment: "g_curve" });
  assert.throws(() => runtime.preview({ durationSeconds: 10, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Vibrate", intensity: 10 }], holdSeconds: 5 }] }] }), /permits Thrusting only/);
  runtime.close();
});

test("preview maps logical levels through per-channel ceilings without dispatch", () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight", ceilings: { Thrusting: 50, Vibrate: 75 } });
  const preview = runtime.preview({ durationSeconds: 30, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Thrusting", intensity: 20 }, { function: "Vibrate", intensity: 20 }], holdSeconds: 5 }] }] });
  const mapped = (((preview.tracks as Array<Record<string, unknown>>)[0]?.steps as Array<Record<string, unknown>>)[0]?.mappedActions as Array<{ intensity: number }>);
  assert.deepEqual(mapped.map((action) => action.intensity), [10, 15]);
  assert.equal(commands.length, 0);
  runtime.close();
});

test("coordinated session dispatches distinct Lush and Spinel tracks", () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 30, tracks: [
    { device: "lush", steps: [{ actions: [{ function: "Vibrate", intensity: 7 }], holdSeconds: 5 }] },
    { device: "spinel", steps: [{ actions: [{ function: "Thrusting", intensity: 14 }, { function: "Vibrate", intensity: 4 }], holdSeconds: 5 }] },
  ] });
  assert.deepEqual(commands.slice(0, 2).map((entry) => [entry.targetIds[0], entry.command.action]), [
    ["lush-1", "Vibrate:7"], ["spinel-1", "Thrusting:14,Vibrate:4"],
  ]);
  runtime.close();
});

test("a constant Spinel step receives a lease for the remaining session instead of five seconds", () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 60, tracks: [{
    device: "spinel",
    steps: [{ actions: [{ function: "Vibrate", intensity: 8 }, { function: "Thrusting", intensity: 12 }], holdSeconds: 60 }],
  }] });
  assert.equal(commands[0]?.command.action, "Vibrate:8,Thrusting:12");
  assert.ok(Number(commands[0]?.command.timeSec) >= 59);
  assert.equal(commands[0]?.command.stopPrevious, 1);
  runtime.close();
});

test("identical consecutive Spinel steps do not redispatch at their boundary", async () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 10, tracks: [{
    device: "spinel",
    steps: [
      { actions: [{ function: "Vibrate", intensity: 8 }, { function: "Thrusting", intensity: 12 }], holdSeconds: 1 },
      { actions: [{ function: "Vibrate", intensity: 8 }, { function: "Thrusting", intensity: 12 }], holdSeconds: 1 },
    ],
  }] });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(commands.filter((entry) => entry.command.action !== "Stop").length, 1);
  runtime.close();
});

test("Spinel step changes replace both channels atomically without a preliminary stop", async () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 10, tracks: [{
    device: "spinel",
    steps: [
      { actions: [{ function: "Vibrate", intensity: 5 }, { function: "Thrusting", intensity: 9 }], holdSeconds: 1 },
      { actions: [{ function: "Vibrate", intensity: 11 }, { function: "Thrusting", intensity: 16 }], holdSeconds: 2 },
    ],
  }] });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(commands.slice(0, 2).map((entry) => [entry.command.action, entry.command.stopPrevious]), [
    ["Vibrate:5,Thrusting:9", 1],
    ["Vibrate:11,Thrusting:16", 0],
  ]);
  assert.equal(commands.slice(0, 2).some((entry) => entry.command.action === "Stop"), false);
  runtime.close();
});

test("an explicit zero-output step is the only timeline step that pauses output", async () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 10, tracks: [{
    device: "spinel",
    steps: [
      { actions: [{ function: "Vibrate", intensity: 5 }, { function: "Thrusting", intensity: 9 }], holdSeconds: 1 },
      { actions: [{ function: "Vibrate", intensity: 0 }, { function: "Thrusting", intensity: 0 }], holdSeconds: 2 },
    ],
  }] });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(commands[1]?.command.action, "Vibrate:0,Thrusting:0");
  assert.equal(commands[1]?.command.stopPrevious, 0);
  runtime.close();
});

test("a failed replacement leaves the previous session authoritative and does not stop it", () => {
  const { runtime, commands, failNext } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 30, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Vibrate", intensity: 8 }, { function: "Thrusting", intensity: 12 }], holdSeconds: 30 }] }] });
  failNext("replacement rejected");
  assert.throws(() => runtime.start({ durationSeconds: 30, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Vibrate", intensity: 10 }, { function: "Thrusting", intensity: 15 }], holdSeconds: 30 }] }] }), /replacement rejected/);
  const status = runtime.status();
  assert.equal(status.sessionId, "1");
  assert.deepEqual((status.targets as Array<Record<string, unknown>>)[0]?.commandedLevels, [
    { function: "Vibrate", intensity: 8 }, { function: "Thrusting", intensity: 12 },
  ]);
  assert.equal(commands.some((entry) => entry.command.action === "Stop"), false);
  const log = status.dispatchLog as Array<Record<string, unknown>>;
  assert.deepEqual([log.at(-1)?.sessionId, log.at(-1)?.stepIndex, log.at(-1)?.state, log.at(-1)?.error], ["2", 0, "failed", "replacement rejected"]);
  runtime.close();
});

test("a successful replacement updates in place and reports accepted but unconfirmed output", () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  const plan = { durationSeconds: 30, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Vibrate" as const, intensity: 8 }, { function: "Thrusting" as const, intensity: 12 }], holdSeconds: 30 }] }] };
  runtime.start(plan);
  const status = runtime.start(plan);
  assert.equal(status.sessionId, "2");
  assert.equal(commands[1]?.command.stopPrevious, 0);
  assert.equal(commands.some((entry) => entry.command.action === "Stop"), false);
  const target = (status.targets as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(target.apiAcceptance, target.dispatch);
  assert.equal(target.outputState, "accepted_unconfirmed");
  assert.equal(target.confirmedActive, false);
  const log = status.dispatchLog as Array<Record<string, unknown>>;
  assert.deepEqual([log.at(-1)?.sessionId, log.at(-1)?.stepIndex, log.at(-1)?.reason, log.at(-1)?.state], ["2", 0, "start", "accepted"]);
  runtime.close();
});

test("a replacement that drops a Spinel channel explicitly zeros it in the atomic update", () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 30, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Vibrate", intensity: 8 }, { function: "Thrusting", intensity: 12 }], holdSeconds: 30 }] }] });
  runtime.start({ durationSeconds: 30, tracks: [{ device: "spinel", steps: [{ actions: [{ function: "Vibrate", intensity: 6 }], holdSeconds: 30 }] }] });
  assert.equal(commands[1]?.command.action, "Vibrate:6,Thrusting:0");
  assert.equal(commands[1]?.command.stopPrevious, 0);
  runtime.close();
});

test("hold stops output, remembers the score, and explicit resume continues it", () => {
  const { runtime, commands } = harness();
  runtime.start({ durationSeconds: 30, tracks: [{ device: "lush", steps: [{ actions: [{ function: "Vibrate", intensity: 9 }], holdSeconds: 5 }] }] });
  const held = runtime.hold();
  assert.equal(held.held, true);
  assert.equal(commands.at(-1)?.command.action, "Stop");
  const resumed = runtime.resume();
  assert.equal(resumed.active, true);
  assert.equal(commands.at(-1)?.command.action, "Vibrate:9");
  runtime.close();
});

test("disconnect holds without silent resume by default", async () => {
  const { runtime, commands, deviceInfo } = harness();
  runtime.start({ durationSeconds: 30, tracks: [{ device: "lush", steps: [{ actions: [{ function: "Vibrate", intensity: 9 }], holdSeconds: 5 }] }] });
  deviceInfo.toys[0]!.connected = false;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(runtime.status().held, true);
  deviceInfo.toys[0]!.connected = true;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(runtime.status().held, true);
  assert.equal(commands.filter((entry) => entry.command.action === "Vibrate:9").length, 1);
  runtime.close();
});

test("stop_device removes only the named track", () => {
  const { runtime, commands } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  runtime.start({ durationSeconds: 30, tracks: [
    { device: "lush", steps: [{ actions: [{ function: "Vibrate", intensity: 7 }], holdSeconds: 5 }] },
    { device: "spinel", steps: [{ actions: [{ function: "Thrusting", intensity: 14 }], holdSeconds: 5 }] },
  ] });
  const status = runtime.stopDevice("spinel");
  assert.equal((status.targets as unknown[]).length, 1);
  assert.deepEqual(commands.at(-1)?.targetIds, ["spinel-1"]);
  runtime.close();
});
