import type { LovenseClient } from "./lovense-client.js";
import { manualOrAppFeaturesFor } from "./capabilities.js";
import { MAX_LIVE_SESSION_SECONDS } from "./types.js";
import type {
  AttachmentProfile,
  DeviceControlProfile,
  FunctionAction,
  LovenseDeviceInfo,
  LovenseFunction,
  SafetyLimits,
  ToyDevice,
} from "./types.js";

const NATIVE_MAXIMUM: Record<LovenseFunction, number> = {
  Vibrate: 20,
  Rotate: 20,
  Pump: 3,
  Thrusting: 20,
  Fingering: 20,
  Suction: 20,
  Depth: 3,
  Stroke: 100,
  Oscillate: 20,
};

export interface EnsembleStep {
  actions: FunctionAction[];
  holdSeconds: number;
  transitionSeconds?: number;
}

export interface EnsembleTrack {
  device: string;
  steps: EnsembleStep[];
}

export interface EnsemblePlan {
  durationSeconds: number;
  tracks: EnsembleTrack[];
  resumeOnReconnect?: boolean;
}

interface ResolvedTrack {
  device: ToyDevice;
  steps: EnsembleStep[];
  cycleSeconds: number;
  channels: LovenseFunction[];
}

interface TimelineFrame {
  actions: FunctionAction[];
  stepIndex: number;
  cycleIndex: number;
  phase: "transition" | "hold";
}

interface DispatchLogEntry {
  sessionId: string;
  deviceId: string;
  alias: string;
  stepIndex: number;
  cycleIndex: number;
  phase: TimelineFrame["phase"];
  reason: "start" | "timeline" | "adjust" | "extend" | "resume" | "rollback";
  state: "accepted" | "failed";
  at: string;
  action: string;
  timeSec: number;
  stopPrevious: 0 | 1;
  error?: string;
}

interface EnsembleSession {
  id: string;
  plan: EnsemblePlan;
  tracks: ResolvedTrack[];
  startedAtMs: number;
  updatedAtMs: number;
  endsAtMs: number;
  pausedAtMs?: number;
  holdReason?: "manual" | "disconnect";
  offsets: Map<string, Map<LovenseFunction, number>>;
  commanded: Map<string, FunctionAction[]>;
  dispatch: Map<string, { state: "accepted" | "failed"; at: string; error?: string }>;
}

export class EnsembleRuntime {
  private readonly profiles = new Map<string, DeviceControlProfile>();
  private session: EnsembleSession | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private lastEvent: Record<string, unknown> | undefined;
  private readonly dispatchLog: DispatchLogEntry[] = [];

  constructor(private readonly client: LovenseClient, private readonly limits: SafetyLimits) {}

  configureProfile(input: {
    device: string;
    alias?: string;
    attachment?: AttachmentProfile;
    ceilings?: Partial<Record<LovenseFunction, number>>;
  }): DeviceControlProfile {
    const device = this.resolveDevice(input.device, false);
    const isSpinel = this.isSpinel(device);
    if (isSpinel && !input.attachment && !this.profiles.get(device.id)?.attachment) {
      throw new Error("Spinel requires an explicit straight or g_curve attachment profile.");
    }
    if (!isSpinel && input.attachment) throw new Error("Attachment profiles are only supported for Spinel.");
    const ceilings = { ...(this.profiles.get(device.id)?.ceilings || {}), ...(input.ceilings || {}) };
    for (const [fn, value] of Object.entries(ceilings)) {
      if (!Number.isInteger(value) || value! < 0 || value! > 100) {
        throw new Error(`${fn} ceiling must be a whole percentage from 0 to 100.`);
      }
    }
    const profile: DeviceControlProfile = {
      deviceId: device.id,
      alias: (input.alias || this.profiles.get(device.id)?.alias || this.defaultAlias(device)).trim().toLowerCase(),
      ...(input.attachment || this.profiles.get(device.id)?.attachment
        ? { attachment: input.attachment || this.profiles.get(device.id)?.attachment }
        : {}),
      ceilings,
    };
    if (!profile.alias) throw new Error("Device alias cannot be empty.");
    const duplicate = [...this.profiles.values()].find((entry) => entry.deviceId !== device.id && entry.alias === profile.alias);
    if (duplicate) throw new Error(`The alias ${profile.alias} is already assigned to another device.`);
    this.profiles.set(device.id, profile);
    this.client.setControlProfile?.(profile);
    return profile;
  }

  listDevices(): Array<Record<string, unknown>> {
    const status = this.client.status();
    return (status.deviceInfo?.toys || []).map((device) => {
      const profile = this.profileFor(device);
      return {
        id: device.id,
        alias: profile.alias,
        name: device.nickname || device.name,
        toyType: device.toyType,
        battery: device.battery,
        connected: device.connected,
        supportedChannels: [...device.capabilities],
        apiChannels: [...device.capabilities],
        manualOrAppFeatures: manualOrAppFeaturesFor(device, profile.attachment),
        capabilitySource: device.capabilitySource,
        verificationState: {
          apiChannels: device.capabilitySource === "device" ? "announced" : device.capabilitySource,
          physicalDelivery: "not_recorded_by_connector",
        },
        attachment: profile.attachment || null,
        ceilings: profile.ceilings,
      };
    });
  }

  preview(plan: EnsemblePlan): Record<string, unknown> {
    const tracks = this.validatePlan(plan, false);
    return {
      dryRun: true,
      durationSeconds: plan.durationSeconds,
      resumeOnReconnect: Boolean(plan.resumeOnReconnect),
      tracks: tracks.map((track) => ({
        deviceId: track.device.id,
        alias: this.profileFor(track.device).alias,
        attachment: this.profileFor(track.device).attachment || null,
        cycleSeconds: track.cycleSeconds,
        steps: track.steps.map((step) => ({
          holdSeconds: step.holdSeconds,
          transitionSeconds: step.transitionSeconds || 0,
          requestedActions: step.actions,
          mappedActions: this.mapActions(track.device, step.actions),
        })),
      })),
      note: "Preview only. No command was sent.",
    };
  }

  start(plan: EnsemblePlan): Record<string, unknown> {
    const tracks = this.validatePlan(plan, true);
    const previous = this.session;
    for (const track of tracks) {
      const previousTrack = previous?.tracks.find((entry) => entry.device.id === track.device.id);
      for (const channel of previousTrack?.channels || []) {
        if (!track.channels.includes(channel)) track.channels.push(channel);
      }
    }
    const now = Date.now();
    const candidate: EnsembleSession = {
      id: String(++this.sequence),
      plan: { ...plan, tracks: plan.tracks.map((track) => ({ ...track, steps: track.steps.map((step) => ({ ...step, actions: this.copyActions(step.actions) })) })) },
      tracks,
      startedAtMs: now,
      updatedAtMs: now,
      endsAtMs: now + plan.durationSeconds * 1000,
      offsets: new Map(),
      commanded: new Map(),
      dispatch: new Map(),
    };

    const acceptedTracks: ResolvedTrack[] = [];
    try {
      for (const track of candidate.tracks) {
        const replacingSameDevice = previous?.tracks.some((entry) => entry.device.id === track.device.id) || false;
        this.dispatchTrack(candidate, track, this.frameAt(track, 0, candidate.offsets.get(track.device.id)), "start", replacingSameDevice ? 0 : 1);
        acceptedTracks.push(track);
      }
    } catch (error) {
      this.rollbackReplacement(previous, acceptedTracks);
      this.lastEvent = {
        sessionId: candidate.id,
        event: "replacement_failed",
        error: error instanceof Error ? error.message : "Dispatch failed.",
        at: new Date().toISOString(),
      };
      throw error;
    }

    this.clearTimer();
    this.session = candidate;
    const replacementIds = new Set(tracks.map((track) => track.device.id));
    for (const track of previous?.tracks || []) {
      if (!replacementIds.has(track.device.id)) this.sendStop(track.device.id);
    }
    if (previous) this.lastEvent = { sessionId: previous.id, event: "replaced", at: new Date().toISOString() };
    this.scheduleTick();
    return this.status();
  }

  adjust(changes: Array<{ device: string; function: LovenseFunction; delta: number }>): Record<string, unknown> {
    const session = this.requireSession(false);
    if (!changes.length) throw new Error("At least one explicit device adjustment is required.");
    for (const change of changes) {
      if (!Number.isInteger(change.delta) || change.delta < -20 || change.delta > 20 || change.delta === 0) {
        throw new Error("Each adjustment delta must be a non-zero integer from -20 to 20.");
      }
      const device = this.resolveSessionDevice(change.device);
      this.assertFunction(device, change.function);
      const offsets = session.offsets.get(device.id) || new Map<LovenseFunction, number>();
      offsets.set(change.function, Math.max(-20, Math.min(20, (offsets.get(change.function) || 0) + change.delta)));
      session.offsets.set(device.id, offsets);
    }
    session.updatedAtMs = Date.now();
    this.dispatchCurrent(false, "adjust");
    return this.status();
  }

  extend(additionalSeconds: number): Record<string, unknown> {
    const session = this.requireSession(false);
    if (!Number.isInteger(additionalSeconds) || additionalSeconds < 1) throw new Error("Extension must be a positive whole number of seconds.");
    const total = Math.ceil((session.endsAtMs - session.startedAtMs) / 1000) + additionalSeconds;
    const ceiling = this.liveSessionCeiling();
    if (total > ceiling) throw new Error(`The complete session cannot exceed ${ceiling} seconds.`);
    session.endsAtMs += additionalSeconds * 1000;
    session.updatedAtMs = Date.now();
    if (!session.pausedAtMs) this.dispatchCurrent(true, "extend");
    return this.status();
  }

  hold(reason: "manual" | "disconnect" = "manual"): Record<string, unknown> {
    const session = this.requireSession(false);
    if (session.pausedAtMs) return this.status();
    for (const track of session.tracks) this.sendStop(track.device.id);
    session.pausedAtMs = Date.now();
    session.holdReason = reason;
    session.updatedAtMs = session.pausedAtMs;
    this.clearTimer();
    this.lastEvent = { sessionId: session.id, event: "held", reason, at: new Date().toISOString() };
    if (reason === "disconnect" && session.plan.resumeOnReconnect) this.scheduleReconnectCheck();
    return this.status();
  }

  resume(): Record<string, unknown> {
    const session = this.requireSession(true);
    if (!session.pausedAtMs) throw new Error("The BLACKVOW session is not on hold.");
    for (const track of session.tracks) {
      if (!this.currentDevice(track.device.id)?.connected) throw new Error(`${this.profileFor(track.device).alias} is not connected.`);
    }
    const pausedFor = Date.now() - session.pausedAtMs;
    session.startedAtMs += pausedFor;
    session.endsAtMs += pausedFor;
    session.pausedAtMs = undefined;
    session.holdReason = undefined;
    session.updatedAtMs = Date.now();
    this.lastEvent = { sessionId: session.id, event: "resumed", at: new Date().toISOString() };
    this.dispatchCurrent(true, "resume");
    if (!session.pausedAtMs) this.scheduleTick();
    return this.status();
  }

  stopDevice(selector: string): Record<string, unknown> {
    const session = this.requireSession(true);
    const device = this.resolveSessionDevice(selector);
    this.sendStop(device.id);
    session.tracks = session.tracks.filter((track) => track.device.id !== device.id);
    session.commanded.delete(device.id);
    session.dispatch.delete(device.id);
    session.updatedAtMs = Date.now();
    this.lastEvent = { sessionId: session.id, event: "device_stopped", deviceId: device.id, at: new Date().toISOString() };
    if (!session.tracks.length) this.finish("stopped");
    return this.status();
  }

  stopAll(event: "stopped" | "replaced" = "stopped"): Record<string, unknown> {
    const session = this.session;
    const ids = session?.tracks.map((track) => track.device.id) || this.connectedDevices().map((device) => device.id);
    for (const id of ids) this.sendStop(id);
    this.clearTimer();
    if (session) this.lastEvent = { sessionId: session.id, event, at: new Date().toISOString() };
    this.session = null;
    return this.status();
  }

  status(): Record<string, unknown> {
    const session = this.session;
    const devices = this.listDevices();
    if (!session) return {
      active: false,
      held: false,
      devices,
      dispatchLog: [...this.dispatchLog],
      ...(this.lastEvent ? { lastEvent: this.lastEvent } : {}),
    };
    const now = session.pausedAtMs || Date.now();
    return {
      active: !session.pausedAtMs,
      held: Boolean(session.pausedAtMs),
      holdReason: session.holdReason || null,
      sessionId: session.id,
      startedAt: new Date(session.startedAtMs).toISOString(),
      updatedAt: new Date(session.updatedAtMs).toISOString(),
      endsAt: new Date(session.endsAtMs).toISOString(),
      elapsedSeconds: Math.max(0, Math.floor((now - session.startedAtMs) / 1000)),
      remainingSeconds: Math.max(0, Math.ceil((session.endsAtMs - now) / 1000)),
      resumeOnReconnect: Boolean(session.plan.resumeOnReconnect),
      targets: session.tracks.map((track) => ({
        deviceId: track.device.id,
        alias: this.profileFor(track.device).alias,
        attachment: this.profileFor(track.device).attachment || null,
        battery: this.currentDevice(track.device.id)?.battery ?? track.device.battery,
        connected: this.currentDevice(track.device.id)?.connected ?? false,
        commandedLevels: this.copyActions(session.commanded.get(track.device.id) || []),
        dispatch: session.dispatch.get(track.device.id) || null,
        apiAcceptance: session.dispatch.get(track.device.id) || null,
        outputState: session.pausedAtMs
          ? "held"
          : session.dispatch.get(track.device.id)?.state !== "accepted"
            ? "not_accepted"
            : this.isZeroOutput(session.commanded.get(track.device.id) || [])
              ? "zero_output_accepted"
              : "accepted_unconfirmed",
        confirmedActive: false,
        confirmation: "The Standard API confirms acceptance, not physical motion.",
      })),
      dispatchLog: [...this.dispatchLog],
      ...(this.lastEvent ? { lastEvent: this.lastEvent } : {}),
    };
  }

  close(): void {
    this.stopAll("stopped");
  }

  private validatePlan(plan: EnsemblePlan, requireConnected: boolean): ResolvedTrack[] {
    const ceiling = this.liveSessionCeiling();
    if (!Number.isInteger(plan.durationSeconds) || plan.durationSeconds < 2 || plan.durationSeconds > ceiling) {
      throw new Error(`Session duration must be between 2 and ${ceiling} seconds.`);
    }
    if (!plan.tracks.length || plan.tracks.length > 16) throw new Error("Choose between 1 and 16 explicit device tracks.");
    const tracks = plan.tracks.map((track) => {
      const device = this.resolveDevice(track.device, requireConnected);
      if (!track.steps.length || track.steps.length > 100) throw new Error("Each device track needs between 1 and 100 steps.");
      let cycleSeconds = 0;
      const channels: LovenseFunction[] = [];
      const steps = track.steps.map((step) => {
        const transition = step.transitionSeconds || 0;
        if (!Number.isInteger(step.holdSeconds) || step.holdSeconds < 0 || step.holdSeconds > 60) throw new Error("holdSeconds must be a whole number from 0 to 60.");
        if (!Number.isInteger(transition) || transition < 0 || transition > 30) throw new Error("transitionSeconds must be a whole number from 0 to 30.");
        if (step.holdSeconds + transition < 1) throw new Error("Each step needs a hold or transition.");
        if (!step.actions.length || step.actions.length > 5) throw new Error("Each step needs between 1 and 5 actions.");
        const seen = new Set<LovenseFunction>();
        for (const action of step.actions) {
          if (seen.has(action.function)) throw new Error("A channel may appear only once in a step.");
          seen.add(action.function);
          if (!channels.includes(action.function)) channels.push(action.function);
          this.assertAction(device, action);
        }
        cycleSeconds += step.holdSeconds + transition;
        return { ...step, transitionSeconds: transition, actions: this.copyActions(step.actions) };
      });
      return { device, steps, cycleSeconds, channels };
    });
    const ids = tracks.map((track) => track.device.id);
    if (new Set(ids).size !== ids.length) throw new Error("Each device may have only one track in a session.");
    return tracks;
  }

  private tick(force: boolean): void {
    const session = this.session;
    if (!session || session.pausedAtMs) return;
    if (Date.now() >= session.endsAtMs) {
      this.finish("expired");
      return;
    }
    const disconnected = session.tracks.find((track) => !this.currentDevice(track.device.id)?.connected);
    if (disconnected) {
      this.hold("disconnect");
      return;
    }
    this.dispatchCurrent(force, "timeline");
    if (session.pausedAtMs) return;
    this.scheduleTick();
  }

  private dispatchCurrent(force: boolean, reason: DispatchLogEntry["reason"]): void {
    const session = this.requireSession(false);
    const elapsedSeconds = Math.max(0, (Date.now() - session.startedAtMs) / 1000);
    for (const track of session.tracks) {
      const frame = this.frameAt(track, elapsedSeconds, session.offsets.get(track.device.id));
      const mapped = this.mapActions(track.device, this.completeActions(track, frame.actions));
      const previous = session.commanded.get(track.device.id);
      if (!force && previous && this.actionString(previous) === this.actionString(mapped)) continue;
      try {
        this.dispatchTrack(session, track, frame, reason, 0);
      } catch (error) {
        this.hold("disconnect");
        return;
      }
    }
  }

  private frameAt(track: ResolvedTrack, elapsedSeconds: number, offsets?: Map<LovenseFunction, number>): TimelineFrame {
    const cycleIndex = Math.floor(elapsedSeconds / track.cycleSeconds);
    let position = elapsedSeconds % track.cycleSeconds;
    let previous = track.steps.at(-1)!.actions;
    for (const [stepIndex, step] of track.steps.entries()) {
      const transition = step.transitionSeconds || 0;
      if (position < transition) {
        const progress = transition ? position / transition : 1;
        return { actions: this.applyOffsets(this.interpolate(track, previous, step.actions, progress), offsets), stepIndex, cycleIndex, phase: "transition" };
      }
      position -= transition;
      if (position < step.holdSeconds) return { actions: this.applyOffsets(step.actions, offsets), stepIndex, cycleIndex, phase: "hold" };
      position -= step.holdSeconds;
      previous = step.actions;
    }
    return { actions: this.applyOffsets(track.steps.at(-1)!.actions, offsets), stepIndex: track.steps.length - 1, cycleIndex, phase: "hold" };
  }

  private interpolate(track: ResolvedTrack, from: FunctionAction[], to: FunctionAction[], progress: number): FunctionAction[] {
    const byFunction = new Map(from.map((action) => [action.function, action]));
    const targets = new Map(to.map((action) => [action.function, action]));
    return track.channels.flatMap((fn) => {
      const target = targets.get(fn);
      if (!target && fn === "Stroke") return [];
      const effectiveTarget = target || { function: fn, intensity: 0 } as FunctionAction;
      if (effectiveTarget.intensity === undefined) return [{ ...effectiveTarget }];
      const start = byFunction.get(effectiveTarget.function)?.intensity || 0;
      return [{ ...effectiveTarget, intensity: Math.round(start + (effectiveTarget.intensity - start) * progress) }];
    });
  }

  private completeActions(track: ResolvedTrack, actions: FunctionAction[]): FunctionAction[] {
    const byFunction = new Map(actions.map((action) => [action.function, action]));
    return track.channels.flatMap((fn) => {
      const action = byFunction.get(fn);
      if (action) return [{ ...action }];
      if (fn === "Stroke") return [];
      return [{ function: fn, intensity: 0 } as FunctionAction];
    });
  }

  private dispatchTrack(
    session: EnsembleSession,
    track: ResolvedTrack,
    frame: TimelineFrame,
    reason: DispatchLogEntry["reason"],
    stopPrevious: 0 | 1,
  ): void {
    const mapped = this.mapActions(track.device, this.completeActions(track, frame.actions));
    const action = this.actionString(mapped);
    // The command lease covers the remaining session envelope. Timeline changes
    // replace this complete channel state before that lease expires.
    const timeSec = Math.max(2, Math.ceil((session.endsAtMs - Date.now()) / 1000));
    const at = new Date().toISOString();
    try {
      this.client.sendCommand({ command: "Function", action, timeSec, stopPrevious, apiVer: 1 }, [track.device.id]);
      session.commanded.set(track.device.id, mapped);
      session.dispatch.set(track.device.id, { state: "accepted", at });
      this.recordDispatch({
        sessionId: session.id,
        deviceId: track.device.id,
        alias: this.profileFor(track.device).alias,
        stepIndex: frame.stepIndex,
        cycleIndex: frame.cycleIndex,
        phase: frame.phase,
        reason,
        state: "accepted",
        at,
        action,
        timeSec,
        stopPrevious,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dispatch failed.";
      session.dispatch.set(track.device.id, { state: "failed", at, error: message });
      this.recordDispatch({
        sessionId: session.id,
        deviceId: track.device.id,
        alias: this.profileFor(track.device).alias,
        stepIndex: frame.stepIndex,
        cycleIndex: frame.cycleIndex,
        phase: frame.phase,
        reason,
        state: "failed",
        at,
        action,
        timeSec,
        stopPrevious,
        error: message,
      });
      throw error;
    }
  }

  private rollbackReplacement(previous: EnsembleSession | null, acceptedTracks: ResolvedTrack[]): void {
    for (const accepted of acceptedTracks) {
      const priorTrack = !previous?.pausedAtMs
        ? previous?.tracks.find((track) => track.device.id === accepted.device.id)
        : undefined;
      if (!previous || !priorTrack) {
        this.sendStop(accepted.device.id);
        continue;
      }
      const elapsedSeconds = Math.max(0, (Date.now() - previous.startedAtMs) / 1000);
      try {
        this.dispatchTrack(previous, priorTrack, this.frameAt(priorTrack, elapsedSeconds, previous.offsets.get(priorTrack.device.id)), "rollback", 0);
      } catch {
        // The failed rollback is retained in dispatchLog; the previous session
        // remains authoritative and its normal disconnect handling still applies.
      }
    }
  }

  private recordDispatch(entry: DispatchLogEntry): void {
    this.dispatchLog.push(entry);
    if (this.dispatchLog.length > 200) this.dispatchLog.splice(0, this.dispatchLog.length - 200);
  }

  private scheduleTick(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.tick(false), 1000);
    this.timer.unref?.();
  }

  private applyOffsets(actions: FunctionAction[], offsets?: Map<LovenseFunction, number>): FunctionAction[] {
    return actions.map((action) => action.intensity === undefined ? { ...action } : {
      ...action,
      intensity: Math.max(0, Math.min(NATIVE_MAXIMUM[action.function], action.intensity + (offsets?.get(action.function) || 0))),
    });
  }

  private mapActions(device: ToyDevice, actions: FunctionAction[]): FunctionAction[] {
    const profile = this.profileFor(device);
    return actions.map((action) => {
      if (action.intensity === undefined) return { ...action };
      const ceiling = profile.ceilings[action.function] ?? 100;
      return { ...action, intensity: Math.round(action.intensity * ceiling / 100) };
    });
  }

  private assertAction(device: ToyDevice, action: FunctionAction): void {
    this.assertFunction(device, action.function);
    if (action.function === "Stroke") {
      if (!Number.isInteger(action.strokeMin) || !Number.isInteger(action.strokeMax) || action.strokeMin! < 0 || action.strokeMax! > 100 || action.strokeMax! - action.strokeMin! < 20) {
        throw new Error("Stroke requires strokeMin/strokeMax from 0 to 100 with a gap of at least 20.");
      }
      return;
    }
    const maximum = NATIVE_MAXIMUM[action.function];
    if (!Number.isInteger(action.intensity) || action.intensity! < 0 || action.intensity! > maximum) {
      throw new Error(`${action.function} must be a whole number from 0 to ${maximum}.`);
    }
  }

  private assertFunction(device: ToyDevice, fn: LovenseFunction): void {
    if (device.capabilitySource === "unknown") throw new Error(`${device.nickname || device.name} did not report supported channels; refusing to guess.`);
    if (!device.capabilities.includes(fn)) throw new Error(`${device.nickname || device.name} does not report ${fn}.`);
    if (this.isSpinel(device)) {
      const attachment = this.profileFor(device).attachment;
      if (!attachment) throw new Error("Spinel needs an explicit straight or g_curve attachment profile before control.");
      if (attachment === "g_curve" && fn !== "Thrusting") throw new Error("The Spinel g_curve attachment permits Thrusting only.");
      if (attachment === "straight" && !["Thrusting", "Vibrate"].includes(fn)) throw new Error("The Spinel straight attachment permits Thrusting and Vibrate through BLACKVOW.");
    }
  }

  private resolveDevice(selector: string, requireConnected: boolean): ToyDevice {
    const normalized = selector.trim().toLowerCase();
    if (!normalized) throw new Error("An explicit device ID or alias is required.");
    const devices = this.client.status().deviceInfo?.toys || [];
    const matches = devices.filter((device) => {
      const profile = this.profileFor(device);
      return device.id.toLowerCase() === normalized || profile.alias === normalized || this.defaultAlias(device) === normalized;
    });
    if (matches.length !== 1) throw new Error(matches.length ? `Device selector ${selector} is ambiguous; use its exact ID.` : `Device ${selector} was not found.`);
    if (requireConnected && !matches[0]!.connected) throw new Error(`${selector} is not connected.`);
    return matches[0]!;
  }

  private resolveSessionDevice(selector: string): ToyDevice {
    const device = this.resolveDevice(selector, false);
    if (!this.session?.tracks.some((track) => track.device.id === device.id)) throw new Error(`${selector} is not part of the active session.`);
    return device;
  }

  private profileFor(device: ToyDevice): DeviceControlProfile {
    const persisted = this.client.controlProfiles?.().find((profile) => profile.deviceId === device.id);
    if (persisted) this.profiles.set(device.id, persisted);
    return this.profiles.get(device.id) || { deviceId: device.id, alias: this.defaultAlias(device), ceilings: {} };
  }

  private defaultAlias(device: ToyDevice): string {
    if (this.isSpinel(device)) return "spinel";
    if (/lush/i.test(`${device.toyType} ${device.name}`)) return "lush";
    return device.id.toLowerCase();
  }

  private isSpinel(device: ToyDevice): boolean {
    return /spinel/i.test(`${device.toyType} ${device.name}`);
  }

  private connectedDevices(): ToyDevice[] {
    return (this.client.status().deviceInfo?.toys || []).filter((device) => device.connected);
  }

  private currentDevice(id: string): ToyDevice | undefined {
    return (this.client.status().deviceInfo?.toys || []).find((device) => device.id === id);
  }

  private actionString(actions: FunctionAction[]): string {
    return actions.map((action) => action.function === "Stroke"
      ? `Stroke:${action.strokeMin}-${action.strokeMax}`
      : `${action.function}:${action.intensity}`).join(",");
  }

  private isZeroOutput(actions: FunctionAction[]): boolean {
    return actions.length > 0 && actions.every((action) => action.function !== "Stroke" && action.intensity === 0);
  }

  private sendStop(deviceId: string): void {
    try {
      this.client.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, [deviceId]);
    } catch {
      // Local session ownership is still cleared even when a disconnected device cannot receive Stop.
    }
  }

  private scheduleReconnectCheck(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      const session = this.session;
      if (!session?.pausedAtMs || session.holdReason !== "disconnect" || !session.plan.resumeOnReconnect) return;
      const ready = session.tracks.every((track) => this.currentDevice(track.device.id)?.connected);
      if (ready) this.resume();
      else this.scheduleReconnectCheck();
    }, 1000);
    this.timer.unref?.();
  }

  private finish(event: "expired" | "stopped"): void {
    const session = this.session;
    if (!session) return;
    for (const track of session.tracks) this.sendStop(track.device.id);
    this.clearTimer();
    this.lastEvent = { sessionId: session.id, event, at: new Date().toISOString() };
    this.session = null;
  }

  private requireSession(allowHeld: boolean): EnsembleSession {
    if (!this.session) throw new Error("No BLACKVOW ensemble session exists.");
    if (!allowHeld && this.session.pausedAtMs) throw new Error("The BLACKVOW session is on hold. Resume it before changing output.");
    return this.session;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private liveSessionCeiling(): number {
    return Math.min(MAX_LIVE_SESSION_SECONDS, this.limits.maxCommandSeconds);
  }

  private copyActions(actions: FunctionAction[]): FunctionAction[] {
    return actions.map((action) => ({ ...action }));
  }
}
