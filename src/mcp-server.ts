import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { EnsembleRuntime, type EnsemblePlan } from "./ensemble-runtime.js";
import type { LovenseClient } from "./lovense-client.js";
import { LOVENSE_FUNCTIONS, type LovenseFunction, type SafetyLimits } from "./types.js";

const functionSchema = z.enum(LOVENSE_FUNCTIONS);
const actionSchema = z.object({
  function: functionSchema,
  intensity: z.number().int().min(0).max(20).optional()
    .describe("BLACKVOW level. Usually 0-20; Pump and Depth are limited to 0-3."),
  strokeMin: z.number().int().min(0).max(100).optional(),
  strokeMax: z.number().int().min(0).max(100).optional(),
});
const stepSchema = z.object({
  actions: z.array(actionSchema).min(1).max(5),
  holdSeconds: z.number().int().min(0).max(60),
  transitionSeconds: z.number().int().min(0).max(30).optional().default(0),
});
const trackSchema = z.object({
  device: z.string().min(1).describe("Explicit device alias such as lush or spinel, or an exact ID from lovense_list_devices."),
  steps: z.array(stepSchema).min(1).max(100),
});

function textResult(message: string, structuredContent?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: message }], ...(structuredContent ? { structuredContent } : {}) };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "The BLACKVOW request failed.";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function planFrom(input: { durationSeconds: number; tracks: unknown[]; resumeOnReconnect: boolean }): EnsemblePlan {
  return input as EnsemblePlan;
}

export function createLovenseMcpServer(client: LovenseClient, ensemble: EnsembleRuntime, limits: SafetyLimits): McpServer {
  const defaultLiveSeconds = Math.min(3600, limits.maxCommandSeconds);
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
    description: "Use this before planning control to read each device separately with its ID, alias, battery, connection, announced channels, attachment profile, and ceilings. This never actuates a device.",
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
    description: "Use this to validate explicit devices, independent channel curves, attachment rules, ceilings, and mapped output before starting. This never actuates a device.",
    inputSchema: {
      durationSeconds: z.number().int().min(2).max(limits.maxCommandSeconds).optional().default(defaultLiveSeconds),
      tracks: z.array(trackSchema).min(1).max(16), resumeOnReconnect: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => {
    try { return textResult("Validated the BLACKVOW session preview. No physical command was sent.", ensemble.preview(planFrom(input))); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_live_start", {
    title: "Start a coordinated BLACKVOW live session",
    description: `Use this only with active consent to start independent, synchronized device tracks in the background. Every track names a device. Default duration is ${Math.round(defaultLiveSeconds / 60)} minutes; ceiling is ${Math.round(limits.maxCommandSeconds / 60)} minutes.`,
    inputSchema: {
      durationSeconds: z.number().int().min(2).max(limits.maxCommandSeconds).optional().default(defaultLiveSeconds),
      tracks: z.array(trackSchema).min(1).max(16),
      resumeOnReconnect: z.boolean().optional().default(false).describe("When true, a disconnect hold may resume automatically after every target reconnects. Default false never silently resumes."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  }, async (input) => {
    try { return textResult("Started the coordinated BLACKVOW live session.", ensemble.start(planFrom(input))); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("lovense_live_status", {
    title: "Read the BLACKVOW live lane",
    description: "Use this to read targets, commanded channels, battery, connection, dispatch acceptance, confirmation limits, hold state, and deadline. This never actuates a device.",
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
    inputSchema: { additionalSeconds: z.number().int().min(1).max(limits.maxCommandSeconds) },
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
