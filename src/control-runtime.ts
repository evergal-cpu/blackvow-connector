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

export interface RoutineResult {
  routineId: string;
  deviceIds: string[];
  phaseCount: number;
  repeat: number;
  totalDurationSeconds: number;
}

/** Shared command state and server-side routine scheduling for every MCP session. */
export class ControlRuntime {
  private readonly levels = new Map<string, Map<LovenseFunction, number>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private routineTimer: ReturnType<typeof setTimeout> | null = null;
  private routineId = 0;

  constructor(
    private readonly client: LovenseClient,
    private readonly safety: SafetyController,
    private readonly limits: SafetyLimits,
  ) {}

  control(actions: FunctionAction[], durationSeconds: number, requestedIds: string[], continueOtherFunctions = false) {
    this.cancelRoutine();
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
    this.rememberLevels(validated.targetIds, actions, continueOtherFunctions);
    if (durationSeconds > 0) this.forgetAfter(validated.targetIds, durationSeconds);
    return validated;
  }

  adjust(changes: RelativeChange[], requestedIds: string[], durationSeconds: number) {
    this.cancelRoutine();
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
      this.rememberLevels([entry.deviceId], entry.actions, false);
    }
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
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.levels.clear();
  }

  stop(requestedIds: string[]): string[] {
    this.cancelRoutine();
    const connectedIds = (this.deviceInfo()?.toys || []).filter((toy) => toy.connected).map((toy) => toy.id);
    if (requestedIds.some((id) => !connectedIds.includes(id))) throw new Error("A requested device is not connected.");
    this.client.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, requestedIds);
    this.forgetLevels(requestedIds.length ? requestedIds : connectedIds);
    return requestedIds;
  }

  close(): void {
    this.cancelRoutine();
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
