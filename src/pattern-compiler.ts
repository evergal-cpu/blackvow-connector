import type { EnsemblePlan, EnsembleStep, EnsembleTrack } from "./ensemble-runtime.js";
import { MAX_LIVE_SESSION_SECONDS } from "./types.js";
import type { FunctionAction } from "./types.js";

export type PatternFunction = "Vibrate" | "Rotate" | "Thrusting" | "Fingering" | "Suction" | "Oscillate";

interface PatternTrackBase {
  device: string;
}

export interface ConstantPatternTrack extends PatternTrackBase {
  shape: "constant";
  channels: Array<{ function: PatternFunction; intensity: number }>;
  holdSeconds: number;
}

export interface PulsePatternTrack extends PatternTrackBase {
  shape: "pulse";
  channels: Array<{ function: PatternFunction; onIntensity: number; offIntensity: number }>;
  onSeconds: number;
  offSeconds: number;
}

export interface WavePatternTrack extends PatternTrackBase {
  shape: "wave";
  channels: Array<{ function: PatternFunction; lowIntensity: number; highIntensity: number }>;
  riseSeconds: number;
  highHoldSeconds: number;
  fallSeconds: number;
  lowHoldSeconds: number;
}

export interface EscalatePatternTrack extends PatternTrackBase {
  shape: "escalate";
  channels: Array<{ function: PatternFunction; startIntensity: number; endIntensity: number }>;
  stages: number;
  stepSeconds: number;
  peakHoldSeconds: number;
}

export interface BuildDenyPatternTrack extends PatternTrackBase {
  shape: "edge" | "build_deny";
  channels: Array<{ function: PatternFunction; peakIntensity: number; denyIntensity: number }>;
  buildSeconds: number;
  peakHoldSeconds: number;
  dropSeconds: number;
  denySeconds: number;
}

export type PatternTrackSpec =
  | ConstantPatternTrack
  | PulsePatternTrack
  | WavePatternTrack
  | EscalatePatternTrack
  | BuildDenyPatternTrack;

export interface PatternPlanInput {
  durationSeconds: number;
  patternTracks: PatternTrackSpec[];
  resumeOnReconnect?: boolean;
}

const NATIVE_MAXIMUM: Record<PatternFunction, number> = {
  Vibrate: 20,
  Rotate: 20,
  Thrusting: 20,
  Fingering: 20,
  Suction: 20,
  Oscillate: 20,
};

const MAX_PATTERN_TRACKS = 16;
const MAX_PATTERN_CHANNELS = 5;
const MAX_COMPILED_STEPS = 100;

export function compilePatternPlan(input: PatternPlanInput, configuredCeiling = MAX_LIVE_SESSION_SECONDS): EnsemblePlan {
  const ceiling = Math.min(MAX_LIVE_SESSION_SECONDS, configuredCeiling);
  assertIntegerInRange(input.durationSeconds, 2, ceiling, `Session duration must be between 2 and ${ceiling} seconds.`);
  if (!Array.isArray(input.patternTracks) || input.patternTracks.length < 1 || input.patternTracks.length > MAX_PATTERN_TRACKS) {
    throw new Error(`Choose between 1 and ${MAX_PATTERN_TRACKS} explicit pattern tracks.`);
  }
  const tracks = input.patternTracks.map(compilePatternTrack);
  const devices = tracks.map((track) => track.device.trim().toLowerCase());
  if (new Set(devices).size !== devices.length) throw new Error("Each device may have only one pattern track in a session.");
  return { durationSeconds: input.durationSeconds, tracks, resumeOnReconnect: Boolean(input.resumeOnReconnect) };
}

export function compilePatternTrack(spec: PatternTrackSpec): EnsembleTrack {
  const device = typeof spec.device === "string" ? spec.device.trim() : "";
  if (!device) throw new Error("Every pattern track requires an explicit device alias or ID.");
  validateChannels(spec.channels);

  let steps: EnsembleStep[];
  switch (spec.shape) {
    case "constant":
      assertIntegerInRange(spec.holdSeconds, 1, 60, "constant holdSeconds must be from 1 to 60.");
      steps = [{ actions: actionsFrom(spec.channels, "intensity"), holdSeconds: spec.holdSeconds }];
      break;
    case "pulse":
      assertIntegerInRange(spec.onSeconds, 1, 60, "pulse onSeconds must be from 1 to 60.");
      assertIntegerInRange(spec.offSeconds, 1, 60, "pulse offSeconds must be from 1 to 60.");
      steps = [
        { actions: actionsFrom(spec.channels, "onIntensity"), holdSeconds: spec.onSeconds },
        { actions: actionsFrom(spec.channels, "offIntensity"), holdSeconds: spec.offSeconds },
      ];
      break;
    case "wave":
      assertIntegerInRange(spec.riseSeconds, 1, 30, "wave riseSeconds must be from 1 to 30.");
      assertIntegerInRange(spec.highHoldSeconds, 0, 60, "wave highHoldSeconds must be from 0 to 60.");
      assertIntegerInRange(spec.fallSeconds, 1, 30, "wave fallSeconds must be from 1 to 30.");
      assertIntegerInRange(spec.lowHoldSeconds, 0, 60, "wave lowHoldSeconds must be from 0 to 60.");
      steps = [
        { actions: actionsFrom(spec.channels, "highIntensity"), transitionSeconds: spec.riseSeconds, holdSeconds: spec.highHoldSeconds },
        { actions: actionsFrom(spec.channels, "lowIntensity"), transitionSeconds: spec.fallSeconds, holdSeconds: spec.lowHoldSeconds },
      ];
      break;
    case "escalate": {
      assertIntegerInRange(spec.stages, 2, 20, "escalate stages must be from 2 to 20.");
      assertIntegerInRange(spec.stepSeconds, 1, 30, "escalate stepSeconds must be from 1 to 30.");
      assertIntegerInRange(spec.peakHoldSeconds, 0, 60, "escalate peakHoldSeconds must be from 0 to 60.");
      steps = Array.from({ length: spec.stages }, (_, index) => {
        const progress = index / (spec.stages - 1);
        const actions = spec.channels.map((channel) => action(channel.function, Math.round(channel.startIntensity + (channel.endIntensity - channel.startIntensity) * progress)));
        if (index === 0) return { actions, holdSeconds: spec.stepSeconds };
        return {
          actions,
          transitionSeconds: spec.stepSeconds,
          holdSeconds: index === spec.stages - 1 ? spec.peakHoldSeconds : 0,
        };
      });
      break;
    }
    case "edge":
    case "build_deny":
      assertIntegerInRange(spec.buildSeconds, 1, 30, "build/deny buildSeconds must be from 1 to 30.");
      assertIntegerInRange(spec.peakHoldSeconds, 0, 60, "build/deny peakHoldSeconds must be from 0 to 60.");
      assertIntegerInRange(spec.dropSeconds, 0, 30, "build/deny dropSeconds must be from 0 to 30.");
      assertIntegerInRange(spec.denySeconds, 1, 60, "build/deny denySeconds must be from 1 to 60.");
      steps = [
        { actions: actionsFrom(spec.channels, "peakIntensity"), transitionSeconds: spec.buildSeconds, holdSeconds: spec.peakHoldSeconds },
        { actions: actionsFrom(spec.channels, "denyIntensity"), transitionSeconds: spec.dropSeconds, holdSeconds: spec.denySeconds },
      ];
      break;
  }

  if (steps.length < 1 || steps.length > MAX_COMPILED_STEPS) throw new Error(`A compiled track must contain between 1 and ${MAX_COMPILED_STEPS} steps.`);
  for (const step of steps) {
    const total = step.holdSeconds + (step.transitionSeconds || 0);
    if (total < 1) throw new Error("Pattern compilation produced a zero-length step.");
  }
  return { device, steps };
}

function actionsFrom<T extends PatternTrackSpec["channels"][number], K extends keyof T>(channels: T[], key: K): FunctionAction[] {
  return channels.map((channel) => action(channel.function, Number(channel[key])));
}

function action(fn: PatternFunction, intensity: number): FunctionAction {
  return { function: fn, intensity };
}

function validateChannels(channels: PatternTrackSpec["channels"]): void {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > MAX_PATTERN_CHANNELS) {
    throw new Error(`Each pattern track needs between 1 and ${MAX_PATTERN_CHANNELS} explicit channels.`);
  }
  const seen = new Set<PatternFunction>();
  for (const channel of channels) {
    if (!Object.hasOwn(NATIVE_MAXIMUM, channel.function)) throw new Error(`${String(channel.function)} is not a scalar BLACKVOW pattern channel.`);
    if (seen.has(channel.function)) throw new Error("A channel may appear only once in a pattern track.");
    seen.add(channel.function);
    const maximum = NATIVE_MAXIMUM[channel.function];
    for (const [key, value] of Object.entries(channel)) {
      if (key === "function") continue;
      assertIntegerInRange(value, 0, maximum, `${channel.function} ${key} must be a whole number from 0 to ${maximum}.`);
    }
  }
}

function assertIntegerInRange(value: unknown, minimum: number, maximum: number, message: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(message);
}
