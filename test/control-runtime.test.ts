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

test("bounded live sessions remain active across calls and adjust without a zero command", () => {
  const { runtime, commands } = harness(120);
  const started = runtime.startLive([{ function: "Vibrate", intensity: 10 }], 30, ["lush-1"]);
  assert.equal(started.active, true);
  assert.equal(started.remainingSeconds, 30);
  assert.equal(commands[0]?.command.action, "Vibrate:10");
  assert.equal(commands[0]?.command.timeSec, 30);

  const adjusted = runtime.adjustLive([{ function: "Vibrate", delta: 4 }], ["lush-1"]);
  assert.equal(adjusted.active, true);
  assert.equal(adjusted.actions?.[0]?.actions[0]?.intensity, 14);
  assert.equal(commands[1]?.command.action, "Vibrate:14");
  assert.notEqual(commands[1]?.command.action, "Stop");
  assert.ok(Number(commands[1]?.command.timeSec) >= 29);
  runtime.close();
});

test("live extension refreshes the current action and moves the safety deadline", () => {
  const { runtime, commands } = harness(120);
  const started = runtime.startLive([{ function: "Vibrate", intensity: 8 }], 20, ["lush-1"]);
  const originalEnd = Date.parse(started.endsAt!);
  const extended = runtime.extendLive(15);
  assert.equal(Date.parse(extended.endsAt!), originalEnd + 15_000);
  assert.equal(commands[1]?.command.action, "Vibrate:8");
  assert.ok(Number(commands[1]?.command.timeSec) >= 34);
  runtime.close();
});

test("stop cancels the active live session immediately", () => {
  const { runtime, commands } = harness();
  runtime.startLive([{ function: "Vibrate", intensity: 7 }], 20, ["lush-1"]);
  runtime.stop(["lush-1"]);
  assert.equal(commands[1]?.command.action, "Stop");
  assert.equal(runtime.liveStatus().active, false);
  assert.equal(runtime.liveStatus().lastEvent?.event, "stopped");
  runtime.close();
});

test("a rejected replacement does not erase the active live session", () => {
  const { runtime, commands } = harness();
  const started = runtime.startLive([{ function: "Vibrate", intensity: 7 }], 20, ["lush-1"]);
  assert.throws(
    () => runtime.control([{ function: "Pump", intensity: 2 }], 10, ["lush-1"]),
    /does not support Pump/,
  );
  assert.equal(runtime.liveStatus().sessionId, started.sessionId);
  assert.equal(commands.length, 1);
  runtime.close();
});

test("named live timelines expose phase, cycle, step and next-change position", () => {
  const { runtime, commands } = harness(7200);
  const status = runtime.startTimeline([
    {
      name: "Ember",
      durationSeconds: 60,
      steps: [
        { actions: [{ function: "Vibrate", intensity: 4 }], holdSeconds: 5, transitionSeconds: 0 },
        { actions: [{ function: "Vibrate", intensity: 9 }], holdSeconds: 5, transitionSeconds: 0 },
      ],
    },
    {
      name: "Climb",
      durationSeconds: 60,
      steps: [{ actions: [{ function: "Vibrate", intensity: 14 }], holdSeconds: 10, transitionSeconds: 5 }],
    },
  ], ["lush-1"]);
  const position = status.position as Record<string, unknown>;
  assert.equal(status.active, true);
  assert.equal(position.phaseName, "Ember");
  assert.equal(position.phaseIndex, 1);
  assert.equal(position.phaseCount, 2);
  assert.equal(position.cycleIndex, 1);
  assert.equal(position.stepIndex, 1);
  assert.equal(position.stepCount, 2);
  assert.equal(position.nextChangeSeconds, 5);
  assert.equal(commands[0]?.command.action, "Vibrate:4");
  runtime.close();
});

test("timeline transitions are precomputed as gradual native-level changes", () => {
  const { runtime, commands } = harness();
  runtime.startTimeline([{
    name: "Climb",
    durationSeconds: 20,
    steps: [{ actions: [{ function: "Vibrate", intensity: 20 }], holdSeconds: 5, transitionSeconds: 5 }],
  }], ["lush-1"]);
  assert.equal(commands[0]?.command.action, "Vibrate:4");
  const position = runtime.timelineStatus().position as Record<string, unknown>;
  assert.equal(position.segment, "transition");
  runtime.close();
});

test("timeline adjustment shifts current and remaining intensity without resetting the deadline", () => {
  const { runtime, commands } = harness();
  const started = runtime.startTimeline([{
    name: "Hook",
    durationSeconds: 30,
    steps: [
      { actions: [{ function: "Vibrate", intensity: 8 }], holdSeconds: 5 },
      { actions: [{ function: "Vibrate", intensity: 12 }], holdSeconds: 5 },
    ],
  }], ["lush-1"]);
  const adjusted = runtime.adjustTimeline([{ function: "Vibrate", delta: 3 }], ["lush-1"]);
  assert.equal(adjusted.endsAt, started.endsAt);
  assert.equal(commands[1]?.command.action, "Vibrate:11");
  const actions = (adjusted.position as Record<string, unknown>).currentActions as Array<{ intensity: number }>;
  assert.equal(actions[0]?.intensity, 11);
  runtime.close();
});

test("timeline extension repeats the final motif within the hard ceiling", () => {
  const { runtime, commands } = harness(120);
  const started = runtime.startTimeline([{
    name: "Ruin's turn",
    durationSeconds: 30,
    steps: [{ actions: [{ function: "Vibrate", intensity: 10 }], holdSeconds: 5 }],
  }], ["lush-1"]);
  const extended = runtime.extendTimeline(15);
  assert.equal(Date.parse(extended.endsAt as string), Date.parse(started.endsAt as string) + 15_000);
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.command.action, "Vibrate:10");
  assert.throws(() => runtime.extendTimeline(90), /no longer than 120 seconds/);
  runtime.close();
});

test("timeline adjustment refuses a function absent from the active score", () => {
  const { runtime, commands } = harness();
  const started = runtime.startTimeline([{
    name: "Hold",
    durationSeconds: 20,
    steps: [{ actions: [{ function: "Vibrate", intensity: 8 }], holdSeconds: 5 }],
  }], ["lush-1"]);
  assert.throws(() => runtime.adjustTimeline([{ function: "Rotate", delta: 2 }], ["lush-1"]), /does not contain Rotate/);
  assert.equal(runtime.timelineStatus().sessionId, started.sessionId);
  assert.equal(commands.length, 1);
  runtime.close();
});

test("a rejected replacement does not erase the active timeline", () => {
  const { runtime, commands } = harness();
  const started = runtime.startTimeline([{
    name: "Hold",
    durationSeconds: 20,
    steps: [{ actions: [{ function: "Vibrate", intensity: 8 }], holdSeconds: 5 }],
  }], ["lush-1"]);
  assert.throws(
    () => runtime.startTimeline([{
      name: "Invalid",
      durationSeconds: 20,
      steps: [{ actions: [{ function: "Pump", intensity: 2 }], holdSeconds: 5 }],
    }], ["lush-1"]),
    /does not support Pump/,
  );
  assert.equal(runtime.timelineStatus().sessionId, started.sessionId);
  assert.equal(commands.length, 1);
  runtime.close();
});

test("timeline advances on the clock and sends an automatic Stop at its deadline", async () => {
  const { runtime, commands } = harness(10);
  runtime.startTimeline([{
    name: "Clock",
    durationSeconds: 2,
    steps: [
      { actions: [{ function: "Vibrate", intensity: 5 }], holdSeconds: 1 },
      { actions: [{ function: "Vibrate", intensity: 9 }], holdSeconds: 1 },
    ],
  }], ["lush-1"]);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.deepEqual(commands.map((entry) => entry.command.action), ["Vibrate:5", "Vibrate:9", "Stop"]);
  assert.equal(runtime.timelineStatus().active, false);
  assert.equal((runtime.timelineStatus().lastEvent as Record<string, unknown>).event, "expired");
  runtime.close();
});
