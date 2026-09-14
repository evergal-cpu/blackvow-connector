import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { EnsembleRuntime, type EnsemblePlan } from "./ensemble-runtime.js";
import type { LovenseClient } from "./lovense-client.js";
import { compilePatternPlan, type PatternTrackSpec } from "./pattern-compiler.js";
import {
  DEFAULT_LIVE_SESSION_SECONDS,
  LOVENSE_FUNCTIONS,
  MAX_LIVE_SESSION_SECONDS,
  type LovenseFunction,
  type SafetyLimits,
} from "./types.js";

const functionSchema = z.enum(LOVENSE_FUNCTIONS);
function twentyLevelAction<const T extends "Vibrate" | "Rotate" | "Thrusting" | "Fingering" | "Suction" | "Oscillate">(fn: T) {
  return z.strictObject({
    function: z.literal(fn),
    intensity: z.number().int().min(0).max(20)
      .describe(`${fn} level as a whole number from 0 to 20.`),
  });
}

function threeLevelAction<const T extends "Pump" | "Depth">(fn: T) {
  return z.strictObject({
    function: z.literal(fn),
    intensity: z.number().int().min(0).max(3)
      .describe(`${fn} level as a whole number from 0 to 3.`),
  });
}

export const actionSchema = z.discriminatedUnion("function", [
  twentyLevelAction("Vibrate"),
  twentyLevelAction("Rotate"),
  twentyLevelAction("Thrusting"),
  twentyLevelAction("Fingering"),
  twentyLevelAction("Suction"),
  twentyLevelAction("Oscillate"),
  threeLevelAction("Pump"),
  threeLevelAction("Depth"),
  z.strictObject({
    function: z.literal("Stroke"),
    strokeMin: z.number().int().min(0).max(100)
      .describe("Minimum stroke position as a whole number from 0 to 100."),
    strokeMax: z.number().int().min(0).max(100)
      .describe("Maximum stroke position as a whole number from 0 to 100, at least 20 above strokeMin."),
  }).refine((action) => action.strokeMax - action.strokeMin >= 20, {
    message: "Stroke needs at least 20 points between strokeMin and strokeMax.",
    path: ["strokeMax"],
  }),
]);
const stepSchema = z.object({
  actions: z.array(actionSchema).min(1).max(5),
  holdSeconds: z.number().int().min(0).max(60),
  transitionSeconds: z.number().int().min(0).max(30).optional().default(0),
});
const trackSchema = z.object({
  device: z.string().min(1).describe("Explicit device alias such as lush or spinel, or an exact ID from lovense_list_devices."),
  steps: z.array(stepSchema).min(1).max(100),
});

const patternFunctionSchema = z.enum(["Vibrate", "Rotate", "Thrusting", "Fingering", "Suction", "Oscillate"]);
const patternChannelSchema = (levels: Record<string, string>) => z.array(z.strictObject({
  function: patternFunctionSchema.describe("An explicit BLACKVOW 0-20 scalar channel; Heat, Turbo, Pump, Depth, and Stroke are not implicit pattern channels."),
  ...Object.fromEntries(Object.entries(levels).map(([name, description]) => [
    name,
    z.number().int().min(0).max(20).describe(description),
  ])),
})).min(1).max(5);

const constantPatternSchema = z.strictObject({
  device: z.string().min(1), shape: z.literal("constant"),
  channels: patternChannelSchema({ intensity: "Constant channel level from 0 to 20." }),
  holdSeconds: z.number().int().min(1).max(60).describe("Seconds per constant cycle, from 1 to 60."),
});
const pulsePatternSchema = z.strictObject({
  device: z.string().min(1), shape: z.literal("pulse"),
  channels: patternChannelSchema({ onIntensity: "On level from 0 to 20.", offIntensity: "Off/floor level from 0 to 20; zero is an explicit pause." }),
  onSeconds: z.number().int().min(1).max(60).describe("Seconds at every explicit onIntensity, from 1 to 60."),
  offSeconds: z.number().int().min(1).max(60).describe("Seconds at every explicit offIntensity, from 1 to 60."),
});
const wavePatternSchema = z.strictObject({
  device: z.string().min(1), shape: z.literal("wave"),
  channels: patternChannelSchema({ lowIntensity: "Wave floor from 0 to 20.", highIntensity: "Wave peak from 0 to 20." }),
  riseSeconds: z.number().int().min(1).max(30).describe("Interpolated rise duration, from 1 to 30 seconds."),
  highHoldSeconds: z.number().int().min(0).max(60).describe("Peak hold, from 0 to 60 seconds."),
  fallSeconds: z.number().int().min(1).max(30).describe("Interpolated fall duration, from 1 to 30 seconds."),
  lowHoldSeconds: z.number().int().min(0).max(60).describe("Floor hold, from 0 to 60 seconds."),
});
const escalatePatternSchema = z.strictObject({
  device: z.string().min(1), shape: z.literal("escalate"),
  channels: patternChannelSchema({ startIntensity: "Starting level from 0 to 20.", endIntensity: "Ending level from 0 to 20." }),
  stages: z.number().int().min(2).max(20).describe("Number of deterministic inclusive levels, from 2 to 20."),
  stepSeconds: z.number().int().min(1).max(30).describe("Seconds for the initial stage and each later transition, from 1 to 30."),
  peakHoldSeconds: z.number().int().min(0).max(60).describe("Additional hold at the final level, from 0 to 60 seconds."),
});
const buildDenyShape = (shape: "edge" | "build_deny") => z.strictObject({
  device: z.string().min(1), shape: z.literal(shape),
  channels: patternChannelSchema({
    peakIntensity: "Build peak level from 0 to 20.",
    denyIntensity: "Explicit floor from 0 to 20. Each loop builds from this floor to the peak, then returns to it; zero is an explicit pause.",
  }),
  buildSeconds: z.number().int().min(1).max(30).describe("Interpolated floor-to-peak build, from 1 to 30 seconds."),
  peakHoldSeconds: z.number().int().min(0).max(60).describe("Peak hold, from 0 to 60 seconds."),
  dropSeconds: z.number().int().min(0).max(30).describe("Peak-to-floor transition, from 0 to 30 seconds; zero is immediate but does not insert a Stop."),
  denySeconds: z.number().int().min(1).max(60).describe("Floor hold, from 1 to 60 seconds."),
});
export const patternTrackSchema = z.discriminatedUnion("shape", [
  constantPatternSchema,
  pulsePatternSchema,
  wavePatternSchema,
  escalatePatternSchema,
  buildDenyShape("edge"),
  buildDenyShape("build_deny"),
]);

function textResult(message: string, structuredContent?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: message }], ...(structuredContent ? { structuredContent } : {}) };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "The BLACKVOW request failed.";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function planFrom(input: {
  durationSeconds: number;
  tracks?: unknown[];
  patternTracks?: unknown[];
  resumeOnReconnect: boolean;
}, liveSessionCeiling: number): EnsemblePlan {
  const hasTracks = Array.isArray(input.tracks);
  const hasPatternTracks = Array.isArray(input.patternTracks);
  if (hasTracks === hasPatternTracks) throw new Error("Provide exactly one of tracks or patternTracks.");
  if (hasPatternTracks) {
    return compilePatternPlan({
      durationSeconds: input.durationSeconds,
      patternTracks: input.patternTracks as PatternTrackSpec[],
      resumeOnReconnect: input.resumeOnReconnect,
    }, liveSessionCeiling);
  }
  return { durationSeconds: input.durationSeconds, tracks: input.tracks as EnsemblePlan["tracks"], resumeOnReconnect: input.resumeOnReconnect };
}

export function createLovenseMcpServer(client: LovenseClient, ensemble: EnsembleRuntime, limits: SafetyLimits): McpServer {
  const liveSessionCeiling = Math.min(MAX_LIVE_SESSION_SECONDS, limits.maxCommandSeconds);
  const defaultLiveSeconds = Math.min(DEFAULT_LIVE_SESSION_SECONDS, liveSessionCeiling);
  const server = new McpServer(
    { name: "blackvow", version: "0.4.0" },
    { instructions: "Discover devices before control. Every physical action must name an explicit device alias or ID and requires the owner's active consent. Use preview for a dry run. BLACKVOW levels are mapped inside configured per-channel ceilings. Hold preserves a session; stop_device clears one target; stop_all clears everything. Never claim physical motion is confirmed because the Standard API confirms dispatch acceptance only." },
  );

  server.registerTool("lovense_status", {
    title: "Check BLACKVOW connection and session status",
    description: "Use this when you need connection state plus the truthful current BLACKVOW session state. This never actuates a device.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => {
    const status = client.status();
    return textResult(status.deviceInfo?.online ? "Lovense Remote is online." : "Lovense Remote is offline.", {
      connectionState: status.connectionState, connectionError: status.lastError || null,
      appOnline: status.deviceInfo?.online || false, session: ensemble.status(),
    });
  });

  server.registerTool("lovense_list_devices", {
    title: "Discover BLACKVOW devices and channels",
    description: "Use this before planning control to read each device separately with its ID, stable alias, battery, connection, BLACKVOW-controllable API channels, app-only features, capability source, verification state, attachment profile, and ceilings. This never actuates a device.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => textResult("Returned BLACKVOW device capabilities.", { devices: ensemble.listDevices() }));

  server.registerTool("lovense_configure_device", {
    title: "Configure a BLACKVOW device profile",
    description: "Use this to assign a stable alias, declare a Spinel attachment, or set per-channel percentage ceilings. This changes BLACKVOW configuration but sends no physical command.",
    inputSchema: {
      device: z.string().min(1), alias: z.string().min(1).max(40).optional(),
      attachment: z.enum(["straight", "g_curve"]).optional(),
      ceilings: z.array(z.object({ channel: functionSchema, percent: z.number().int().min(0).max(100) })).max(9).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ device, alias, attachment, ceilings }) => {
    try {
      const ceilingMap = Object.fromEntries((ceilings || []).map((entry) => [entry.channel, entry.percent])) as Partial<Record<LovenseFunction, number>>;
      const profile = ensemble.configureProfile({ device, alias, attachment, ceilings: ceilingMap });
      return textResult("Updated the BLACKVOW device profile. No physical command was sent.", { profile, physicalCommandSent: false });
    } catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_preview", {
    title: "Preview a coordinated BLACKVOW session",
    description: "Use this to validate explicit devices, independent channel curves, attachment rules, ceilings, and mapped output before starting. Provide either canonical tracks or concise patternTracks (constant, pulse, wave, escalate, edge/build_deny), never both. Pattern tracks compile deterministically into the same canonical steps and never send Lovense Pattern commands. An omitted duration uses the default one-hour live-session window: a looping session envelope. Short bounded tests must supply an explicit duration. This never actuates a device.",
    inputSchema: {
      durationSeconds: z.number().int().min(2).max(liveSessionCeiling).optional().default(defaultLiveSeconds)
        .describe("Session envelope in seconds. Omit for the default one-hour live-session window; maximum 7200 seconds. Supply an explicit duration for short bounded tests."),
      tracks: z.array(trackSchema).min(1).max(16).optional(),
      patternTracks: z.array(patternTrackSchema).min(1).max(16).optional()
        .describe("Neutral high-level patterns compiled into canonical BLACKVOW tracks. Every device and channel remains explicit."),
      resumeOnReconnect: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => {
    try { return textResult("Validated the BLACKVOW session preview. No physical command was sent.", ensemble.preview(planFrom(input, liveSessionCeiling))); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_live_start", {
    title: "Start a coordinated BLACKVOW live session",
    description: `Use this only with active consent to start independent, synchronized device tracks in the background. Provide either canonical tracks or concise patternTracks (constant, pulse, wave, escalate, edge/build_deny), never both. Pattern tracks compile into canonical steps before validation and dispatch; they never bypass BLACKVOW with Lovense Pattern or opaque loop commands. Every track names a device and every channel is explicit. Omitting duration uses the default one-hour live-session window. Short bounded tests must supply an explicit duration. The ceiling is ${Math.round(liveSessionCeiling / 60)} minutes.`,
    inputSchema: {
      durationSeconds: z.number().int().min(2).max(liveSessionCeiling).optional().default(defaultLiveSeconds)
        .describe("Session envelope in seconds. Omit for the default one-hour live-session window; maximum 7200 seconds. Supply an explicit duration for short bounded tests."),
      tracks: z.array(trackSchema).min(1).max(16).optional(),
      patternTracks: z.array(patternTrackSchema).min(1).max(16).optional()
        .describe("Neutral high-level patterns compiled into canonical BLACKVOW tracks. Every device and channel remains explicit."),
      resumeOnReconnect: z.boolean().optional().default(false).describe("When true, a disconnect hold may resume automatically after every target reconnects. Default false never silently resumes."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => {
    try { return textResult("Started the coordinated BLACKVOW live session.", ensemble.start(planFrom(input, liveSessionCeiling))); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_live_status", {
    title: "Read the BLACKVOW live lane",
    description: "Use this to read targets, commanded channels, battery, connection, API/dispatch acceptance separately from unconfirmed physical output, per-step dispatch/error logs, hold state, and deadline. This never actuates a device.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => textResult("Returned the BLACKVOW live-session state.", ensemble.status()));

  server.registerTool("lovense_live_adjust", {
    title: "Adjust explicit BLACKVOW device channels",
    description: "Use this only with active consent to shift named channels on named devices while preserving the session clock and coordinated score.",
    inputSchema: { changes: z.array(z.object({
      device: z.string().min(1), function: functionSchema,
      delta: z.number().int().min(-20).max(20).refine((value) => value !== 0, "Delta cannot be zero."),
    })).min(1).max(32) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async ({ changes }) => {
    try { return textResult("Adjusted the explicit BLACKVOW targets without changing the deadline.", ensemble.adjust(changes)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_live_extend", {
    title: "Extend the BLACKVOW session",
    description: "Use this only with active consent to add time while preserving the current coordinated score, up to the configured ceiling.",
    inputSchema: { additionalSeconds: z.number().int().min(1).max(liveSessionCeiling) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async ({ additionalSeconds }) => {
    try { return textResult("Extended the BLACKVOW session.", ensemble.extend(additionalSeconds)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_hold", {
    title: "Hold BLACKVOW output but remember the session",
    description: "Use this immediately when the owner asks to hold or pause. It sends Stop to every session target but preserves the score and remaining time for an explicit resume.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => {
    try { return textResult("BLACKVOW is on hold and remembers the session.", ensemble.hold()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_resume", {
    title: "Resume a held BLACKVOW session",
    description: "Use this only with fresh active consent to resume a held score after verifying every target is connected.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async () => {
    try { return textResult("Resumed the held BLACKVOW session.", ensemble.resume()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_stop_device", {
    title: "Stop and clear one BLACKVOW device",
    description: "Use this immediately to stop one explicitly named device and remove only its track from the session.",
    inputSchema: { device: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ device }) => {
    try { return textResult(`Stopped and cleared ${device}.`, ensemble.stopDevice(device)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_stop_all", {
    title: "Stop and clear all BLACKVOW output",
    description: "Use this immediately for Stop all, Red, discomfort, or cancellation. It stops every connected BLACKVOW device and clears the session.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => textResult("Stopped and cleared all BLACKVOW output.", ensemble.stopAll()));

  return server;
}

interface SessionEntry { transport: StreamableHTTPServerTransport; server: McpServer }

export class McpHttpHandler {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly ensemble: EnsembleRuntime;

  constructor(private readonly client: LovenseClient, private readonly limits: SafetyLimits) {
    this.ensemble = new EnsembleRuntime(client, limits);
  }

  async handle(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.headers["mcp-session-id"];
      const id = typeof sessionId === "string" ? sessionId : undefined;
      let entry = id ? this.sessions.get(id) : undefined;
      if (!entry && req.method === "POST" && !id && isInitializeRequest(req.body)) {
        let transport!: StreamableHTTPServerTransport;
        const server = createLovenseMcpServer(this.client, this.ensemble, this.limits);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => { this.sessions.set(newId, { transport, server }); },
        });
        transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId); };
        await server.connect(transport);
        entry = { transport, server };
      }
      if (!entry) {
        res.status(id ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32000, message: id ? "Unknown MCP session" : "Initialize the MCP session first" }, id: null });
        return;
      }
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal MCP error" }, id: null });
      console.error("MCP request failed:", error instanceof Error ? error.message : "unknown error");
    }
  }

  async close(): Promise<void> {
    this.ensemble.close();
    await Promise.all([...this.sessions.values()].map((entry) => entry.transport.close()));
    this.sessions.clear();
  }
}
