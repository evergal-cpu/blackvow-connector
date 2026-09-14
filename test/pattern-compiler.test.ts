import assert from "node:assert/strict";
import test from "node:test";
import { EnsembleRuntime } from "../src/ensemble-runtime.js";
import { compilePatternPlan, compilePatternTrack, type PatternTrackSpec } from "../src/pattern-compiler.js";
import type { LovenseDeviceInfo } from "../src/types.js";

function harness(failWhen?: (command: Record<string, unknown>) => boolean) {
  const deviceInfo: LovenseDeviceInfo = {
    online: true, appType: "remote", appVersion: "test", platform: "test", updatedAt: new Date().toISOString(),
    toys: [{
      id: "spinel-1", name: "Spinel", toyType: "spinel", nickname: "Spinel", battery: 100, connected: true,
      capabilities: ["Vibrate", "Thrusting"], capabilitySource: "device",
    }],
  };
  const commands: Array<{ command: Record<string, unknown>; targetIds: string[] }> = [];
  const client = {
    status: () => ({ connectionState: "connected", lastError: "", deviceInfo }),
    sendCommand: (command: Record<string, unknown>, targetIds: string[]) => {
      if (failWhen?.(command)) throw new Error("mock dispatch rejected");
      commands.push({ command, targetIds });
    },
  };
  const runtime = new EnsembleRuntime(client as never, { maxCommandSeconds: 7200 });
  runtime.configureProfile({ device: "spinel", attachment: "straight" });
  return { runtime, commands };
}

test("constant compiles to one canonical hold step", () => {
  assert.deepEqual(compilePatternTrack({
    device: "spinel", shape: "constant", holdSeconds: 12,
    channels: [{ function: "Vibrate", intensity: 7 }, { function: "Thrusting", intensity: 13 }],
  }), {
    device: "spinel",
    steps: [{ actions: [{ function: "Vibrate", intensity: 7 }, { function: "Thrusting", intensity: 13 }], holdSeconds: 12 }],
  });
});

test("pulse compiles explicit on and floor values without inventing a pause", () => {
  const track = compilePatternTrack({
    device: "spinel", shape: "pulse", onSeconds: 3, offSeconds: 2,
    channels: [{ function: "Vibrate", onIntensity: 14, offIntensity: 4 }, { function: "Thrusting", onIntensity: 18, offIntensity: 9 }],
  });
  assert.deepEqual(track.steps, [
    { actions: [{ function: "Vibrate", intensity: 14 }, { function: "Thrusting", intensity: 18 }], holdSeconds: 3 },
    { actions: [{ function: "Vibrate", intensity: 4 }, { function: "Thrusting", intensity: 9 }], holdSeconds: 2 },
  ]);
});

test("wave compiles seamless rise and fall transitions with independent channel ranges", () => {
  const track = compilePatternTrack({
    device: "spinel", shape: "wave", riseSeconds: 4, highHoldSeconds: 1, fallSeconds: 5, lowHoldSeconds: 2,
    channels: [{ function: "Vibrate", lowIntensity: 2, highIntensity: 11 }, { function: "Thrusting", lowIntensity: 7, highIntensity: 19 }],
  });
  assert.deepEqual(track.steps, [
    { actions: [{ function: "Vibrate", intensity: 11 }, { function: "Thrusting", intensity: 19 }], transitionSeconds: 4, holdSeconds: 1 },
    { actions: [{ function: "Vibrate", intensity: 2 }, { function: "Thrusting", intensity: 7 }], transitionSeconds: 5, holdSeconds: 2 },
  ]);
});

test("escalate compiles deterministic rounded stages with no duration drift", () => {
  const track = compilePatternTrack({
    device: "spinel", shape: "escalate", stages: 4, stepSeconds: 2, peakHoldSeconds: 3,
    channels: [{ function: "Vibrate", startIntensity: 2, endIntensity: 14 }, { function: "Thrusting", startIntensity: 5, endIntensity: 20 }],
  });
  assert.deepEqual(track.steps.map((step) => [step.actions.map((entry) => entry.intensity), step.transitionSeconds || 0, step.holdSeconds]), [
    [[2, 5], 0, 2],
    [[6, 10], 2, 0],
    [[10, 15], 2, 0],
    [[14, 20], 2, 3],
  ]);
  assert.equal(track.steps.reduce((total, step) => total + step.holdSeconds + (step.transitionSeconds || 0), 0), 11);
});

test("edge and build_deny compile to the same neutral build/reduction cycle", () => {
  const base = {
    device: "spinel", channels: [{ function: "Vibrate" as const, peakIntensity: 17, denyIntensity: 2 }],
    buildSeconds: 8, peakHoldSeconds: 2, dropSeconds: 1, denySeconds: 4,
  };
  assert.deepEqual(compilePatternTrack({ ...base, shape: "edge" }).steps, compilePatternTrack({ ...base, shape: "build_deny" }).steps);
  assert.deepEqual(compilePatternTrack({ ...base, shape: "edge" }).steps, [
    { actions: [{ function: "Vibrate", intensity: 17 }], transitionSeconds: 8, holdSeconds: 2 },
    { actions: [{ function: "Vibrate", intensity: 2 }], transitionSeconds: 1, holdSeconds: 4 },
  ]);
});

test("compiler rejects zero-length timing, duplicate channels, and excessive total duration", () => {
  assert.throws(() => compilePatternTrack({
    device: "spinel", shape: "constant", holdSeconds: 0,
    channels: [{ function: "Vibrate", intensity: 7 }],
  }), /holdSeconds/);
  assert.throws(() => compilePatternTrack({
    device: "spinel", shape: "pulse", onSeconds: 2, offSeconds: 2,
    channels: [{ function: "Vibrate", onIntensity: 7, offIntensity: 2 }, { function: "Vibrate", onIntensity: 8, offIntensity: 3 }],
  }), /only once/);
  assert.throws(() => compilePatternPlan({
    durationSeconds: 121,
    patternTracks: [{ device: "spinel", shape: "constant", holdSeconds: 10, channels: [{ function: "Vibrate", intensity: 7 }] }],
  }, 120), /between 2 and 120/);
});

test("compiled Spinel channels retain independent values and configured ceilings", () => {
  const { runtime } = harness();
  runtime.configureProfile({ device: "spinel", attachment: "straight", ceilings: { Vibrate: 50, Thrusting: 75 } });
  const plan = compilePatternPlan({
    durationSeconds: 30,
    patternTracks: [{
      device: "spinel", shape: "constant", holdSeconds: 10,
      channels: [{ function: "Vibrate", intensity: 20 }, { function: "Thrusting", intensity: 20 }],
    }],
  });
  const preview = runtime.preview(plan);
  const steps = ((preview.tracks as Array<Record<string, unknown>>)[0]?.steps as Array<Record<string, unknown>>);
  assert.deepEqual(steps[0]?.mappedActions, [{ function: "Vibrate", intensity: 10 }, { function: "Thrusting", intensity: 15 }]);
  runtime.close();
});

test("compiled adjacent transitions dispatch atomically without a Stop command", async () => {
  const { runtime, commands } = harness();
  runtime.start(compilePatternPlan({
    durationSeconds: 10,
    patternTracks: [{
      device: "spinel", shape: "wave", riseSeconds: 1, highHoldSeconds: 0, fallSeconds: 2, lowHoldSeconds: 1,
      channels: [{ function: "Vibrate", lowIntensity: 2, highIntensity: 10 }, { function: "Thrusting", lowIntensity: 6, highIntensity: 18 }],
    }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(commands[0]?.command.action, "Vibrate:2,Thrusting:6");
  assert.equal(commands[1]?.command.stopPrevious, 0);
  assert.equal(commands.slice(0, 2).some((entry) => entry.command.action === "Stop"), false);
  runtime.close();
});

test("compiled unchanged pulse output is suppressed at the step boundary", async () => {
  const { runtime, commands } = harness();
  runtime.start(compilePatternPlan({
    durationSeconds: 10,
    patternTracks: [{
      device: "spinel", shape: "pulse", onSeconds: 1, offSeconds: 1,
      channels: [{ function: "Vibrate", onIntensity: 8, offIntensity: 8 }, { function: "Thrusting", onIntensity: 12, offIntensity: 12 }],
    }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(commands.filter((entry) => entry.command.action !== "Stop").length, 1);
  runtime.close();
});

test("compiled replacement explicitly zeros a removed channel", () => {
  const { runtime, commands } = harness();
  runtime.start(compilePatternPlan({
    durationSeconds: 30,
    patternTracks: [{ device: "spinel", shape: "constant", holdSeconds: 10, channels: [{ function: "Vibrate", intensity: 8 }, { function: "Thrusting", intensity: 14 }] }],
  }));
  runtime.start(compilePatternPlan({
    durationSeconds: 30,
    patternTracks: [{ device: "spinel", shape: "constant", holdSeconds: 10, channels: [{ function: "Vibrate", intensity: 6 }] }],
  }));
  assert.equal(commands[1]?.command.action, "Vibrate:6,Thrusting:0");
  assert.equal(commands[1]?.command.stopPrevious, 0);
  runtime.close();
});

test("compiler failure cannot replace a currently active session", () => {
  const { runtime, commands } = harness();
  runtime.start(compilePatternPlan({
    durationSeconds: 30,
    patternTracks: [{ device: "spinel", shape: "constant", holdSeconds: 10, channels: [{ function: "Vibrate", intensity: 8 }] }],
  }));
  const invalid = {
    device: "spinel", shape: "pulse", onSeconds: 0, offSeconds: 2,
    channels: [{ function: "Vibrate", onIntensity: 12, offIntensity: 3 }],
  } as unknown as PatternTrackSpec;
  assert.throws(() => compilePatternPlan({ durationSeconds: 30, patternTracks: [invalid] }), /onSeconds/);
  assert.equal(runtime.status().sessionId, "1");
  assert.equal(commands.filter((entry) => entry.command.action !== "Stop").length, 1);
  runtime.close();
});

test("failed initial dispatch of a compiled replacement keeps the active session", () => {
  const { runtime, commands } = harness((command) => command.action === "Vibrate:15");
  runtime.start(compilePatternPlan({
    durationSeconds: 30,
    patternTracks: [{ device: "spinel", shape: "constant", holdSeconds: 10, channels: [{ function: "Vibrate", intensity: 8 }] }],
  }));
  assert.throws(() => runtime.start(compilePatternPlan({
    durationSeconds: 30,
    patternTracks: [{ device: "spinel", shape: "constant", holdSeconds: 10, channels: [{ function: "Vibrate", intensity: 15 }] }],
  })), /mock dispatch rejected/);
  assert.equal(runtime.status().sessionId, "1");
  assert.equal(commands[0]?.command.action, "Vibrate:8");
  assert.equal(commands.some((entry) => entry.command.action === "Stop"), false);
  runtime.close();
});
