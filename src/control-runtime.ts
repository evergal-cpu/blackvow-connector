import type { LovenseClient } from "./lovense-client.js";
import { SafetyController } from "./safety.js";
import type { FunctionAction, LovenseDeviceInfo, LovenseFunction, SafetyLimits } from "./types.js";

const THREE_LEVEL_FUNCTIONS = new Set<LovenseFunction>(["Pump", "Depth"]);

export interface RelativeChange {
  function: LovenseFunction;
  delta: number;
}

export interface RoutinePhase {
  actions: FunctionAction[];
  durationSeconds: number;
}

export interface LiveTimelineStep {
  actions: FunctionAction[];
  holdSeconds: number;
  transitionSeconds?: number;
}

export interface LiveTimelinePhase {
  name: string;
  steps: LiveTimelineStep[];
  durationSeconds: number;
}

export interface RoutineResult {
  routineId: string;
  deviceIds: string[];
  phaseCount: number;
  repeat: number;
  totalDurationSeconds: number;
}

export interface LiveSessionSnapshot {
  active: boolean;
  sessionId?: string;
  deviceIds?: string[];
  actions?: Array<{ deviceId: string; actions: FunctionAction[] }>;
  startedAt?: string;
  updatedAt?: string;
  endsAt?: string;
  remainingSeconds?: number;
  lastEvent?: {
    sessionId: string;
    event: "expired" | "replaced" | "stopped" | "error";
    at: string;
    error?: string;
  };
}

interface ActiveLiveSession {
  id: string;
  deviceIds: string[];
  actionsByDevice: Map<string, FunctionAction[]>;
  startedAtMs: number;
  updatedAtMs: number;
  endsAtMs: number;
}

interface PlannedSegment {
  phaseIndex: number;
  phaseName: string;
  phaseCount: number;
  cycleIndex: number;
  stepIndex: number;
  stepCount: number;
  kind: "transition" | "hold";
  durationMs: number;
  actions: FunctionAction[];
  nextActions: FunctionAction[];
}

interface ActiveTimeline {
  id: string;
  deviceIds: string[];
  phases: LiveTimelinePhase[];
  segments: PlannedSegment[];
  segmentIndex: number;
  startedAtMs: number;
  updatedAtMs: number;
  endsAtMs: number;
  segmentStartedAtMs: number;
  segmentEndsAtMs: number;
}

/** Shared command state and server-side routine scheduling for every MCP session. */
export class ControlRuntime {
  private readonly levels = new Map<string, Map<LovenseFunction, number>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private routineTimer: ReturnType<typeof setTimeout> | null = null;
  private routineId = 0;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private liveSession: ActiveLiveSession | null = null;
  private liveSessionId = 0;
  private lastLiveEvent: LiveSessionSnapshot["lastEvent"];
  private timelineTimer: ReturnType<typeof setTimeout> | null = null;
  private timeline: ActiveTimeline | null = null;
  private timelineId = 0;
  private lastTimelineEvent: LiveSessionSnapshot["lastEvent"];

  constructor(
    private readonly client: LovenseClient,
    private readonly safety: SafetyController,
    private readonly limits: SafetyLimits,
  ) {}

  control(actions: FunctionAction[], durationSeconds: number, requestedIds: string[], continueOtherFunctions = false) {
    const validated = this.safety.validateControl(actions, durationSeconds, requestedIds, this.deviceInfo());
    this.client.sendCommand(
      {
        command: "Function",
        action: validated.action,
        timeSec: validated.durationSeconds,
        stopPrevious: continueOtherFunctions ? 0 : 1,
        apiVer: 1,
      },
      validated.targetIds,
    );
    this.cancelRoutine();
    this.clearLiveSession("replaced");
    this.clearTimeline("replaced");
    this.rememberLevels(validated.targetIds, actions, continueOtherFunctions);
    if (durationSeconds > 0) this.forgetAfter(validated.targetIds, durationSeconds);
    return validated;
  }

  adjust(changes: RelativeChange[], requestedIds: string[], durationSeconds: number) {
    if (changes.length === 0 || changes.length > 5) throw new Error("Choose between 1 and 5 relative changes.");
    const functions = changes.map((change) => change.function);
    if (new Set(functions).size !== functions.length) throw new Error("Each function may be adjusted only once per command.");
    const targetIds = this.safety.validatePattern(functions, requestedIds, this.deviceInfo());
    const actionsByDevice = targetIds.map((deviceId) => {
      const known = this.levels.get(deviceId);
      const actions = changes.map((change) => {
        const current = known?.get(change.function);
        if (current === undefined) {
          throw new Error(`The current ${change.function} level is unknown. Set it once with lovense_control before using relative adjustment.`);
        }
        const maximum = THREE_LEVEL_FUNCTIONS.has(change.function) ? 3 : 20;
        const intensity = Math.max(0, Math.min(maximum, current + change.delta));
        return { function: change.function, intensity } satisfies FunctionAction;
      });
      const validated = this.safety.validateControl(actions, durationSeconds, [deviceId], this.deviceInfo());
      return { deviceId, actions, validated };
    });

    for (const entry of actionsByDevice) {
      this.client.sendCommand(
        { command: "Function", action: entry.validated.action, timeSec: durationSeconds, stopPrevious: 1, apiVer: 1 },
        [entry.deviceId],
      );
    }
    this.cancelRoutine();
    this.clearLiveSession("replaced");
    this.clearTimeline("replaced");
    for (const entry of actionsByDevice) this.rememberLevels([entry.deviceId], entry.actions, false);
    if (durationSeconds > 0) this.forgetAfter(targetIds, durationSeconds);
    return {
      targetIds,
      durationSeconds,
      resultingActions: actionsByDevice.map(({ deviceId, validated }) => ({ deviceId, action: validated.action })),
    };
  }

  startRoutine(phases: RoutinePhase[], repeat: number, requestedIds: string[]): RoutineResult {
    if (phases.length === 0 || phases.length > 24) throw new Error("Choose between 1 and 24 routine phases.");
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) throw new Error("Routine repeat must be an integer from 1 to 50.");
    const onePassSeconds = phases.reduce((sum, phase) => sum + phase.durationSeconds, 0);
    const totalDurationSeconds = onePassSeconds * repeat;
    if (totalDurationSeconds > this.limits.maxCommandSeconds) {
      throw new Error(`The complete routine must be no longer than ${this.limits.maxCommandSeconds} seconds.`);
    }

    const validated = phases.map((phase) => this.safety.validateControl(
      phase.actions,
      phase.durationSeconds,
      requestedIds,
      this.deviceInfo(),
    ));
    const targetIds = validated[0]!.targetIds;
    this.cancelRoutine();
    this.clearLiveSession("replaced");
    this.clearTimeline("replaced");
    const id = String(++this.routineId);
    let step = 0;
    const expanded = Array.from({ length: repeat }, () => phases.map((phase, index) => ({ phase, command: validated[index]! }))).flat();

    const runNext = () => {
      if (String(this.routineId) !== id) return;
      const entry = expanded[step++];
      if (!entry) {
        this.routineTimer = null;
        this.forgetLevels(targetIds);
        return;
      }
      try {
        this.client.sendCommand(
          { command: "Function", action: entry.command.action, timeSec: entry.phase.durationSeconds, stopPrevious: 1, apiVer: 1 },
          targetIds,
        );
        this.rememberLevels(targetIds, entry.phase.actions, false);
        this.routineTimer = setTimeout(runNext, entry.phase.durationSeconds * 1000);
        this.routineTimer.unref?.();
      } catch (error) {
        this.routineTimer = null;
        this.forgetLevels(targetIds);
        console.error("BLACKVOW routine stopped:", error instanceof Error ? error.message : "unknown error");
        try {
          this.client.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, targetIds);
        } catch {
          // The connection is already unavailable; there is nothing else to stop remotely.
        }
      }
    };
    runNext();
    return { routineId: id, deviceIds: targetIds, phaseCount: phases.length, repeat, totalDurationSeconds };
  }

  patternStarted(): void {
    this.cancelRoutine();
    this.clearLiveSession("replaced");
    this.clearTimeline("replaced");
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.levels.clear();
  }

  stop(requestedIds: string[]): string[] {
    this.cancelRoutine();
    const connectedIds = (this.deviceInfo()?.toys || []).filter((toy) => toy.connected).map((toy) => toy.id);
    if (requestedIds.some((id) => !connectedIds.includes(id))) throw new Error("A requested device is not connected.");
    this.client.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, requestedIds);
    this.clearLiveSession("stopped");
    this.clearTimeline("stopped");
    this.forgetLevels(requestedIds.length ? requestedIds : connectedIds);
    return requestedIds;
  }

  startLive(actions: FunctionAction[], durationSeconds: number, requestedIds: string[]): LiveSessionSnapshot {
    if (durationSeconds === 0) throw new Error("A live session must have a finite safety deadline.");
    const validated = this.safety.validateControl(actions, durationSeconds, requestedIds, this.deviceInfo());
    this.client.sendCommand(
      { command: "Function", action: validated.action, timeSec: durationSeconds, stopPrevious: 1, apiVer: 1 },
      validated.targetIds,
    );

    this.cancelRoutine();
    this.clearLiveSession("replaced");
    this.clearTimeline("replaced");
    const now = Date.now();
    const id = String(++this.liveSessionId);
    this.liveSession = {
      id,
      deviceIds: [...validated.targetIds],
      actionsByDevice: new Map(validated.targetIds.map((deviceId) => [deviceId, this.copyActions(actions)])),
      startedAtMs: now,
      updatedAtMs: now,
      endsAtMs: now + durationSeconds * 1000,
    };
    this.rememberLevels(validated.targetIds, actions, false);
    this.scheduleLiveStop(id);
    return this.liveStatus();
  }

  adjustLive(changes: RelativeChange[], requestedIds: string[]): LiveSessionSnapshot {
    const session = this.requireLiveSession();
    if (changes.length === 0 || changes.length > 5) throw new Error("Choose between 1 and 5 relative changes.");
    const functions = changes.map((change) => change.function);
    if (new Set(functions).size !== functions.length) throw new Error("Each function may be adjusted only once per command.");

    const targetIds = requestedIds.length ? [...new Set(requestedIds)] : [...session.deviceIds];
    if (targetIds.some((id) => !session.deviceIds.includes(id))) throw new Error("A requested device is not part of the active live session.");
    this.safety.validatePattern(functions, targetIds, this.deviceInfo());
    const remainingSeconds = this.remainingLiveSeconds(session);
    const replacements = targetIds.map((deviceId) => {
      const known = this.levels.get(deviceId);
      if (!known) throw new Error("The active level is unknown. Start a new live session before adjusting it.");
      const next = new Map(known);
      for (const change of changes) {
        const current = next.get(change.function);
        if (current === undefined) throw new Error(`The current ${change.function} level is unknown.`);
        const maximum = THREE_LEVEL_FUNCTIONS.has(change.function) ? 3 : 20;
        next.set(change.function, Math.max(0, Math.min(maximum, current + change.delta)));
      }
      const actions = [...next.entries()].map(([fn, intensity]) => ({ function: fn, intensity } satisfies FunctionAction));
      const validated = this.safety.validateControl(actions, remainingSeconds, [deviceId], this.deviceInfo());
      return { deviceId, actions, action: validated.action };
    });

    for (const replacement of replacements) {
      this.client.sendCommand(
        { command: "Function", action: replacement.action, timeSec: remainingSeconds, stopPrevious: 1, apiVer: 1 },
        [replacement.deviceId],
      );
    }
    for (const replacement of replacements) {
      session.actionsByDevice.set(replacement.deviceId, this.copyActions(replacement.actions));
      this.rememberLevels([replacement.deviceId], replacement.actions, false);
    }
    session.updatedAtMs = Date.now();
    return this.liveStatus();
  }

  extendLive(additionalSeconds: number): LiveSessionSnapshot {
    const session = this.requireLiveSession();
    if (!Number.isInteger(additionalSeconds) || additionalSeconds < 1) {
      throw new Error("Live-session extension must be a positive whole number of seconds.");
    }
    const nextEndsAtMs = session.endsAtMs + additionalSeconds * 1000;
    const totalSeconds = Math.ceil((nextEndsAtMs - session.startedAtMs) / 1000);
    if (totalSeconds > this.limits.maxCommandSeconds) {
      throw new Error(`The complete live session must be no longer than ${this.limits.maxCommandSeconds} seconds.`);
    }
    const remainingSeconds = Math.max(2, Math.ceil((nextEndsAtMs - Date.now()) / 1000));
    for (const deviceId of session.deviceIds) {
      const actions = session.actionsByDevice.get(deviceId) || [];
      const validated = this.safety.validateControl(actions, remainingSeconds, [deviceId], this.deviceInfo());
      this.client.sendCommand(
        { command: "Function", action: validated.action, timeSec: remainingSeconds, stopPrevious: 1, apiVer: 1 },
        [deviceId],
      );
    }
    session.endsAtMs = nextEndsAtMs;
    session.updatedAtMs = Date.now();
    this.scheduleLiveStop(session.id);
    return this.liveStatus();
  }

  liveStatus(): LiveSessionSnapshot {
    const session = this.liveSession;
    if (!session) return { active: false, ...(this.lastLiveEvent ? { lastEvent: this.lastLiveEvent } : {}) };
    return {
      active: true,
      sessionId: session.id,
      deviceIds: [...session.deviceIds],
      actions: session.deviceIds.map((deviceId) => ({
        deviceId,
        actions: this.copyActions(session.actionsByDevice.get(deviceId) || []),
      })),
      startedAt: new Date(session.startedAtMs).toISOString(),
      updatedAt: new Date(session.updatedAtMs).toISOString(),
      endsAt: new Date(session.endsAtMs).toISOString(),
      remainingSeconds: Math.max(0, Math.ceil((session.endsAtMs - Date.now()) / 1000)),
      ...(this.lastLiveEvent ? { lastEvent: this.lastLiveEvent } : {}),
    };
  }

  startTimeline(phases: LiveTimelinePhase[], requestedIds: string[]): Record<string, unknown> {
    const { normalized, targetIds, totalDurationSeconds } = this.validateTimeline(phases, requestedIds);
    const startingActions = this.knownActions(targetIds[0]!);
    const segments = this.buildTimelineSegments(normalized, startingActions);
    if (!segments.length) throw new Error("The live timeline did not contain any runnable time.");

    const now = Date.now();
    const first = segments[0]!;
    const firstLease = this.segmentLeaseSeconds(first.durationMs, totalDurationSeconds);
    const firstCommand = this.safety.validateControl(first.actions, firstLease, targetIds, this.deviceInfo());
    this.client.sendCommand(
      { command: "Function", action: firstCommand.action, timeSec: firstLease, stopPrevious: 1, apiVer: 1 },
      targetIds,
    );

    this.cancelRoutine();
    this.clearLiveSession("replaced");
    this.clearTimeline("replaced");
    const id = String(++this.timelineId);
    this.timeline = {
      id,
      deviceIds: [...targetIds],
      phases: normalized,
      segments,
      segmentIndex: 0,
      startedAtMs: now,
      updatedAtMs: now,
      endsAtMs: now + totalDurationSeconds * 1000,
      segmentStartedAtMs: now,
      segmentEndsAtMs: now + first.durationMs,
    };
    this.rememberLevels(targetIds, first.actions, false);
    this.scheduleTimelineStep(id, first.durationMs);
    return this.timelineStatus();
  }

  adjustTimeline(changes: RelativeChange[], requestedIds: string[]): Record<string, unknown> {
    const timeline = this.requireTimeline();
    if (changes.length === 0 || changes.length > 5) throw new Error("Choose between 1 and 5 relative changes.");
    const functions = changes.map((change) => change.function);
    if (new Set(functions).size !== functions.length) throw new Error("Each function may be adjusted only once per command.");
    const targetIds = requestedIds.length ? [...new Set(requestedIds)] : [...timeline.deviceIds];
    if (targetIds.some((id) => !timeline.deviceIds.includes(id))) throw new Error("A requested device is not part of the active timeline.");
    if (targetIds.length !== timeline.deviceIds.length || timeline.deviceIds.some((id) => !targetIds.includes(id))) {
      throw new Error("A timeline adjustment applies to every device in the active timeline; omit deviceIds or include them all.");
    }
    const activeFunctions = new Set(
      timeline.segments.slice(timeline.segmentIndex).flatMap((segment) =>
        [...segment.actions, ...segment.nextActions].map((action) => action.function)),
    );
    const missing = functions.find((fn) => !activeFunctions.has(fn));
    if (missing) throw new Error(`The active timeline does not contain ${missing}; start a replacement timeline to add a new function.`);
    this.safety.validatePattern(functions, targetIds, this.deviceInfo());

    const shifted = timeline.segments.slice(timeline.segmentIndex).map((segment) => ({
      ...segment,
      actions: this.shiftActions(segment.actions, changes),
      nextActions: this.shiftActions(segment.nextActions, changes),
    }));
    const current = shifted[0]!;
    const remainingSegmentMs = Math.max(1, timeline.segmentEndsAtMs - Date.now());
    const remainingSessionSeconds = Math.max(2, Math.ceil((timeline.endsAtMs - Date.now()) / 1000));
    const lease = Math.min(remainingSessionSeconds, this.segmentLeaseSeconds(remainingSegmentMs, remainingSessionSeconds));
    const validated = this.safety.validateControl(current.actions, lease, targetIds, this.deviceInfo());
    this.client.sendCommand(
      { command: "Function", action: validated.action, timeSec: lease, stopPrevious: 1, apiVer: 1 },
      targetIds,
    );

    timeline.segments.splice(timeline.segmentIndex, shifted.length, ...shifted);
    timeline.updatedAtMs = Date.now();
    this.rememberLevels(targetIds, current.actions, false);
    return this.timelineStatus();
  }

  extendTimeline(additionalSeconds: number): Record<string, unknown> {
    const timeline = this.requireTimeline();
    if (!Number.isInteger(additionalSeconds) || additionalSeconds < 2) {
      throw new Error("Timeline extension must be at least 2 whole seconds.");
    }
    const totalSeconds = Math.ceil((timeline.endsAtMs - timeline.startedAtMs) / 1000) + additionalSeconds;
    if (totalSeconds > this.limits.maxCommandSeconds) {
      throw new Error(`The complete live timeline must be no longer than ${this.limits.maxCommandSeconds} seconds.`);
    }
    const finalPhase = timeline.phases.at(-1)!;
    const extensionPhase: LiveTimelinePhase = { ...finalPhase, durationSeconds: additionalSeconds };
    const lastActions = timeline.segments.at(-1)?.actions || this.knownActions(timeline.deviceIds[0]!);
    const extra = this.buildTimelineSegments([extensionPhase], lastActions).map((segment) => ({
      ...segment,
      phaseIndex: timeline.phases.length - 1,
      phaseCount: timeline.phases.length,
    }));

    const current = timeline.segments[timeline.segmentIndex]!;
    const remainingSegmentMs = Math.max(1, timeline.segmentEndsAtMs - Date.now());
    const extendedRemainingSeconds = Math.max(2, Math.ceil((timeline.endsAtMs + additionalSeconds * 1000 - Date.now()) / 1000));
    const lease = this.segmentLeaseSeconds(remainingSegmentMs, extendedRemainingSeconds);
    const validated = this.safety.validateControl(current.actions, lease, timeline.deviceIds, this.deviceInfo());
    this.client.sendCommand(
      { command: "Function", action: validated.action, timeSec: lease, stopPrevious: 1, apiVer: 1 },
      timeline.deviceIds,
    );

    timeline.segments.push(...extra);
    timeline.endsAtMs += additionalSeconds * 1000;
    timeline.updatedAtMs = Date.now();
    return this.timelineStatus();
  }

  timelineStatus(): Record<string, unknown> {
    const timeline = this.timeline;
    if (!timeline) {
      return { active: false, ...(this.lastTimelineEvent ? { lastEvent: this.lastTimelineEvent } : {}) };
    }
    const now = Date.now();
    const segment = timeline.segments[timeline.segmentIndex]!;
    return {
      active: true,
      mode: "timeline",
      sessionId: timeline.id,
      deviceIds: [...timeline.deviceIds],
      startedAt: new Date(timeline.startedAtMs).toISOString(),
      updatedAt: new Date(timeline.updatedAtMs).toISOString(),
      endsAt: new Date(timeline.endsAtMs).toISOString(),
      elapsedSeconds: Math.max(0, Math.round((now - timeline.startedAtMs) / 100) / 10),
      remainingSeconds: Math.max(0, Math.ceil((timeline.endsAtMs - now) / 1000)),
      position: {
        phaseIndex: segment.phaseIndex + 1,
        phaseCount: segment.phaseCount,
        phaseName: segment.phaseName,
        cycleIndex: segment.cycleIndex,
        stepIndex: segment.stepIndex + 1,
        stepCount: segment.stepCount,
        segment: segment.kind,
        segmentElapsedSeconds: Math.max(0, Math.round((now - timeline.segmentStartedAtMs) / 100) / 10),
        segmentRemainingSeconds: Math.max(0, Math.ceil((timeline.segmentEndsAtMs - now) / 1000)),
        currentActions: this.copyActions(segment.actions),
        nextActions: this.copyActions(segment.nextActions),
        nextChangeSeconds: Math.max(0, Math.ceil((timeline.segmentEndsAtMs - now) / 1000)),
      },
      ...(this.lastTimelineEvent ? { lastEvent: this.lastTimelineEvent } : {}),
    };
  }

  close(): void {
    this.cancelRoutine();
    this.clearLiveSession("stopped");
    this.clearTimeline("stopped");
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  private deviceInfo(): LovenseDeviceInfo | null {
    return this.client.status().deviceInfo;
  }

  private cancelRoutine(): void {
    this.routineId += 1;
    if (this.routineTimer) clearTimeout(this.routineTimer);
    this.routineTimer = null;
  }

  private requireLiveSession(): ActiveLiveSession {
    const session = this.liveSession;
    if (!session || session.endsAtMs <= Date.now()) throw new Error("No active BLACKVOW live session was found.");
    return session;
  }

  private requireTimeline(): ActiveTimeline {
    const timeline = this.timeline;
    if (!timeline || timeline.endsAtMs <= Date.now()) throw new Error("No active BLACKVOW live timeline was found.");
    return timeline;
  }

  private validateTimeline(phases: LiveTimelinePhase[], requestedIds: string[]): {
    normalized: LiveTimelinePhase[];
    targetIds: string[];
    totalDurationSeconds: number;
  } {
    if (phases.length === 0 || phases.length > 10) throw new Error("Choose between 1 and 10 named timeline phases.");
    const normalized = phases.map((phase) => {
      const name = phase.name.trim();
      if (!name || name.length > 64) throw new Error("Each phase name must contain between 1 and 64 characters.");
      if (!Number.isInteger(phase.durationSeconds) || phase.durationSeconds < 2) {
        throw new Error("Each timeline phase must last at least 2 whole seconds.");
      }
      if (phase.steps.length === 0 || phase.steps.length > 100) throw new Error("Each phase needs between 1 and 100 steps.");
      const steps = phase.steps.map((step) => {
        const transitionSeconds = step.transitionSeconds || 0;
        if (!Number.isInteger(step.holdSeconds) || step.holdSeconds < 0 || step.holdSeconds > 60) {
          throw new Error("Timeline holdSeconds must be a whole number from 0 to 60.");
        }
        if (!Number.isInteger(transitionSeconds) || transitionSeconds < 0 || transitionSeconds > 30) {
          throw new Error("Timeline transitionSeconds must be a whole number from 0 to 30.");
        }
        if (step.holdSeconds + transitionSeconds < 1) throw new Error("Every timeline step needs a hold or transition.");
        return { actions: this.copyActions(step.actions), holdSeconds: step.holdSeconds, transitionSeconds };
      });
      return { name, durationSeconds: phase.durationSeconds, steps };
    });
    const totalDurationSeconds = normalized.reduce((sum, phase) => sum + phase.durationSeconds, 0);
    if (totalDurationSeconds > this.limits.maxCommandSeconds) {
      throw new Error(`The complete live timeline must be no longer than ${this.limits.maxCommandSeconds} seconds.`);
    }
    let targetIds: string[] | null = null;
    for (const phase of normalized) {
      for (const step of phase.steps) {
        const validated = this.safety.validateControl(step.actions, 2, requestedIds, this.deviceInfo());
        targetIds ||= validated.targetIds;
      }
    }
    return { normalized, targetIds: targetIds!, totalDurationSeconds };
  }

  private buildTimelineSegments(phases: LiveTimelinePhase[], initialActions: FunctionAction[]): PlannedSegment[] {
    const segments: PlannedSegment[] = [];
    let previous = this.copyActions(initialActions);
    for (const [phaseIndex, phase] of phases.entries()) {
      let phaseRemainingMs = phase.durationSeconds * 1000;
      let cycleIndex = 0;
      while (phaseRemainingMs > 0) {
        cycleIndex += 1;
        for (const [stepIndex, step] of phase.steps.entries()) {
          if (phaseRemainingMs <= 0) break;
          const target = this.copyActions(step.actions);
          const transitionMs = Math.min((step.transitionSeconds || 0) * 1000, phaseRemainingMs);
          let transitionedMs = 0;
          while (transitionedMs < transitionMs) {
            const durationMs = Math.min(1000, transitionMs - transitionedMs);
            transitionedMs += durationMs;
            const progress = transitionedMs / transitionMs;
            const actions = this.interpolateActions(previous, target, progress);
            segments.push({
              phaseIndex, phaseName: phase.name, phaseCount: phases.length, cycleIndex, stepIndex,
              stepCount: phase.steps.length, kind: "transition", durationMs, actions, nextActions: target,
            });
            phaseRemainingMs -= durationMs;
            if (phaseRemainingMs <= 0) break;
          }
          if (phaseRemainingMs <= 0) break;
          const holdMs = Math.min(step.holdSeconds * 1000, phaseRemainingMs);
          if (holdMs > 0) {
            segments.push({
              phaseIndex, phaseName: phase.name, phaseCount: phases.length, cycleIndex, stepIndex,
              stepCount: phase.steps.length, kind: "hold", durationMs: holdMs, actions: target, nextActions: target,
            });
            phaseRemainingMs -= holdMs;
          }
          previous = target;
        }
      }
    }
    for (let index = 0; index < segments.length - 1; index += 1) {
      segments[index]!.nextActions = this.copyActions(segments[index + 1]!.actions);
    }
    if (segments.length) segments.at(-1)!.nextActions = [];
    return segments;
  }

  private interpolateActions(from: FunctionAction[], to: FunctionAction[], progress: number): FunctionAction[] {
    const previous = new Map(from.map((action) => [action.function, action]));
    return to.map((target) => {
      if (target.intensity === undefined) return { ...target };
      const start = previous.get(target.function)?.intensity || 0;
      return { ...target, intensity: Math.round(start + (target.intensity - start) * progress) };
    });
  }

  private shiftActions(actions: FunctionAction[], changes: RelativeChange[]): FunctionAction[] {
    const byFunction = new Map(changes.map((change) => [change.function, change.delta]));
    return actions.map((action) => {
      const delta = byFunction.get(action.function);
      if (delta === undefined || action.intensity === undefined) return { ...action };
      const maximum = THREE_LEVEL_FUNCTIONS.has(action.function) ? 3 : 20;
      return { ...action, intensity: Math.max(0, Math.min(maximum, action.intensity + delta)) };
    });
  }

  private knownActions(deviceId: string): FunctionAction[] {
    return [...(this.levels.get(deviceId) || new Map()).entries()].map(([fn, intensity]) => ({ function: fn, intensity }));
  }

  private segmentLeaseSeconds(durationMs: number, remainingSessionSeconds: number): number {
    return Math.max(2, Math.min(remainingSessionSeconds, Math.ceil(durationMs / 1000) + 2));
  }

  private scheduleTimelineStep(sessionId: string, delayMs: number): void {
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    this.timelineTimer = setTimeout(() => this.advanceTimeline(sessionId), delayMs);
    this.timelineTimer.unref?.();
  }

  private advanceTimeline(sessionId: string): void {
    const timeline = this.timeline;
    if (!timeline || timeline.id !== sessionId) return;
    const nextIndex = timeline.segmentIndex + 1;
    if (nextIndex >= timeline.segments.length || Date.now() >= timeline.endsAtMs) {
      this.finishTimeline(sessionId);
      return;
    }
    const segment = timeline.segments[nextIndex]!;
    const remainingSessionSeconds = Math.max(2, Math.ceil((timeline.endsAtMs - Date.now()) / 1000));
    const lease = this.segmentLeaseSeconds(segment.durationMs, remainingSessionSeconds);
    try {
      const validated = this.safety.validateControl(segment.actions, lease, timeline.deviceIds, this.deviceInfo());
      this.client.sendCommand(
        { command: "Function", action: validated.action, timeSec: lease, stopPrevious: 1, apiVer: 1 },
        timeline.deviceIds,
      );
      const now = Date.now();
      timeline.segmentIndex = nextIndex;
      timeline.segmentStartedAtMs = now;
      timeline.segmentEndsAtMs = Math.min(timeline.endsAtMs, now + segment.durationMs);
      this.rememberLevels(timeline.deviceIds, segment.actions, false);
      this.scheduleTimelineStep(sessionId, timeline.segmentEndsAtMs - now);
    } catch (error) {
      this.failTimeline(sessionId, error);
    }
  }

  private finishTimeline(sessionId: string): void {
    const timeline = this.timeline;
    if (!timeline || timeline.id !== sessionId) return;
    try {
      this.client.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, timeline.deviceIds);
      this.lastTimelineEvent = { sessionId, event: "expired", at: new Date().toISOString() };
    } catch (error) {
      this.lastTimelineEvent = {
        sessionId, event: "error", at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "The timeline stop could not be delivered.",
      };
    }
    this.forgetLevels(timeline.deviceIds);
    this.timeline = null;
    this.timelineTimer = null;
  }

  private failTimeline(sessionId: string, error: unknown): void {
    const timeline = this.timeline;
    if (!timeline || timeline.id !== sessionId) return;
    try {
      this.client.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, timeline.deviceIds);
    } catch {
      // The connection failure that ended the timeline also prevents a remote Stop.
    }
    this.lastTimelineEvent = {
      sessionId, event: "error", at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "The live timeline failed.",
    };
    this.forgetLevels(timeline.deviceIds);
    this.timeline = null;
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    this.timelineTimer = null;
  }

  private clearTimeline(event: "replaced" | "stopped"): void {
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    this.timelineTimer = null;
    if (!this.timeline) return;
    this.lastTimelineEvent = { sessionId: this.timeline.id, event, at: new Date().toISOString() };
    this.timeline = null;
  }

  private remainingLiveSeconds(session: ActiveLiveSession): number {
    const remaining = Math.ceil((session.endsAtMs - Date.now()) / 1000);
    if (remaining < 2) throw new Error("The live session is too close to its safety deadline. Extend it or start a new session.");
    return remaining;
  }

  private scheduleLiveStop(sessionId: string): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    const session = this.liveSession;
    if (!session || session.id !== sessionId) return;
    this.liveTimer = setTimeout(() => {
      const current = this.liveSession;
      if (!current || current.id !== sessionId) return;
      let errorMessage: string | undefined;
      try {
        this.client.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, current.deviceIds);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "The automatic stop could not be delivered.";
      }
      this.lastLiveEvent = {
        sessionId,
        event: errorMessage ? "error" : "expired",
        at: new Date().toISOString(),
        ...(errorMessage ? { error: errorMessage } : {}),
      };
      this.liveSession = null;
      this.liveTimer = null;
      this.forgetLevels(current.deviceIds);
    }, Math.max(0, session.endsAtMs - Date.now()));
    this.liveTimer.unref?.();
  }

  private clearLiveSession(event: "replaced" | "stopped"): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    if (!this.liveSession) return;
    this.lastLiveEvent = { sessionId: this.liveSession.id, event, at: new Date().toISOString() };
    this.liveSession = null;
  }

  private copyActions(actions: FunctionAction[]): FunctionAction[] {
    return actions.map((action) => ({ ...action }));
  }

  private rememberLevels(deviceIds: string[], actions: FunctionAction[], continueOtherFunctions: boolean): void {
    for (const deviceId of deviceIds) {
      const expiry = this.expiryTimers.get(deviceId);
      if (expiry) clearTimeout(expiry);
      this.expiryTimers.delete(deviceId);
      const known = continueOtherFunctions ? (this.levels.get(deviceId) || new Map<LovenseFunction, number>()) : new Map<LovenseFunction, number>();
      for (const action of actions) {
        if (action.function !== "Stroke" && action.intensity !== undefined) known.set(action.function, action.intensity);
      }
      this.levels.set(deviceId, known);
    }
  }

  private forgetAfter(deviceIds: string[], durationSeconds: number): void {
    for (const deviceId of deviceIds) {
      const timer = setTimeout(() => {
        if (this.expiryTimers.get(deviceId) !== timer) return;
        this.levels.delete(deviceId);
        this.expiryTimers.delete(deviceId);
      }, durationSeconds * 1000);
      timer.unref?.();
      this.expiryTimers.set(deviceId, timer);
    }
  }

  private forgetLevels(deviceIds: string[]): void {
    for (const deviceId of deviceIds) {
      const expiry = this.expiryTimers.get(deviceId);
      if (expiry) clearTimeout(expiry);
      this.expiryTimers.delete(deviceId);
      this.levels.delete(deviceId);
    }
  }
}
