import type {
  FunctionAction,
  LovenseDeviceInfo,
  LovenseFunction,
  SafetyLimits,
  ToyDevice,
} from "./types.js";

const THREE_LEVEL_FUNCTIONS = new Set<LovenseFunction>(["Pump", "Depth"]);

export interface ValidatedControl {
  action: string;
  durationSeconds: number;
  targetIds: string[];
  warnings: string[];
}

export class SafetyController {
  constructor(private readonly limits: SafetyLimits) {}

  validateControl(
    actions: FunctionAction[],
    durationSeconds: number,
    requestedToyIds: string[],
    devices: LovenseDeviceInfo | null,
  ): ValidatedControl {
    if (!Number.isFinite(durationSeconds) || (durationSeconds !== 0 && (durationSeconds < 2 || durationSeconds > this.limits.maxCommandSeconds))) {
      throw new Error(`Duration must be 0 (until stopped) or between 2 and ${this.limits.maxCommandSeconds} seconds.`);
    }
    if (actions.length === 0 || actions.length > 5) throw new Error("Choose between 1 and 5 functions.");

    const targets = this.resolveTargets(requestedToyIds, devices);
    const warnings: string[] = [];
    const parts = actions.map((item) => {
      this.validateCapability(item.function, targets, warnings);
      if (item.function === "Stroke") {
        const min = item.strokeMin;
        const max = item.strokeMax;
        if (!Number.isInteger(min) || !Number.isInteger(max) || min! < 0 || max! > 100 || max! - min! < 20) {
          throw new Error("Stroke needs integer strokeMin/strokeMax from 0 to 100 with at least 20 points between them.");
        }
        return `Stroke:${min}-${max}`;
      }
      const apiMaximum = THREE_LEVEL_FUNCTIONS.has(item.function) ? 3 : 20;
      if (!Number.isInteger(item.intensity) || item.intensity! < 0 || item.intensity! > apiMaximum) {
        throw new Error(`${item.function} intensity must be an integer from 0 to ${apiMaximum}.`);
      }
      return `${item.function}:${item.intensity}`;
    });

    return { action: parts.join(","), durationSeconds, targetIds: targets.map((toy) => toy.id), warnings };
  }

  validatePattern(functions: LovenseFunction[], requestedToyIds: string[], devices: LovenseDeviceInfo | null): string[] {
    const targets = this.resolveTargets(requestedToyIds, devices);
    const warnings: string[] = [];
    for (const fn of functions) this.validateCapability(fn, targets, warnings);
    return targets.map((toy) => toy.id);
  }

  private resolveTargets(requestedToyIds: string[], devices: LovenseDeviceInfo | null): ToyDevice[] {
    if (!devices?.online) throw new Error("Lovense Remote is offline. Open the app and connect the toy first.");
    const connected = devices.toys.filter((toy) => toy.connected);
    if (connected.length === 0) throw new Error("No connected Lovense devices were found.");
    if (requestedToyIds.length === 0) {
      throw new Error("Explicit device targeting is required. Use a device ID returned by lovense_list_devices.");
    }
    const wanted = [...new Set(requestedToyIds)];
    const byId = new Map(connected.map((toy) => [toy.id, toy]));
    if (wanted.some((id) => !byId.has(id))) throw new Error("A target device is not connected.");
    return wanted.map((id) => byId.get(id)!);
  }

  private validateCapability(fn: LovenseFunction, toys: ToyDevice[], warnings: string[]): void {
    for (const toy of toys) {
      if (toy.capabilitySource === "unknown") {
        warnings.push(`${toy.nickname || toy.name} did not announce capabilities; Lovense will verify ${fn}.`);
      } else if (!toy.capabilities.includes(fn)) {
        throw new Error(`${toy.nickname || toy.name} does not support ${fn}.`);
      }
    }
  }
}
