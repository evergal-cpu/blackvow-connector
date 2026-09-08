import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { ControlRuntime, type RoutinePhase } from "./control-runtime.js";
import { SafetyController } from "./safety.js";
import type { LovenseClient } from "./lovense-client.js";
import { LOVENSE_FUNCTIONS, type FunctionAction, type LovenseFunction, type SafetyLimits } from "./types.js";

const functionSchema = z.enum(LOVENSE_FUNCTIONS);
const patternFunctionSchema = z.enum([
  "Vibrate",
  "Rotate",
  "Pump",
  "Thrusting",
  "Fingering",
  "Suction",
  "Depth",
  "Oscillate",
]);

function textResult(message: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "The Lovense command failed.";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function createLovenseMcpServer(client: LovenseClient, runtime: ControlRuntime, safety: SafetyController, limits: SafetyLimits): McpServer {
  const server = new McpServer(
    { name: "blackvow", version: "0.2.0" },
    {
      instructions:
        "Call lovense_list_devices before control and never guess device functions. Use control tools only with the owner's active consent. A duration of 0 means continue until stopped and should only be used when explicitly requested. lovense_stop is always available and cancels an active routine.",
    },
  );

  server.registerTool(
    "lovense_status",
    {
      title: "Check Lovense safety status",
      description: "Use this when you need to know whether Lovense Remote and the connected devices are online.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      const status = client.status();
      return textResult(status.deviceInfo?.online ? "Lovense Remote is online." : "Lovense Remote is offline.", {
        connectionState: status.connectionState,
        appOnline: status.deviceInfo?.online || false,
      });
    },
  );

  server.registerTool(
    "lovense_list_devices",
    {
      title: "List connected Lovense devices",
      description: "Use this when you need the connected device IDs, battery levels, and supported functions before choosing a control command.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      const devices = client.status().deviceInfo?.toys || [];
      return textResult(
        devices.length ? `Found ${devices.length} Lovense device${devices.length === 1 ? "" : "s"}.` : "No Lovense devices are connected.",
        { devices },
      );
    },
  );

  server.registerTool(
    "lovense_control",
    {
      title: "Control Lovense functions",
      description: "Use this when the owner explicitly asks to run one or more supported functions on one or several connected devices for a short duration.",
      inputSchema: {
        actions: z.array(
          z.object({
            function: functionSchema.describe("A function announced for the selected device."),
            intensity: z.number().int().min(0).max(20).optional().describe("0-20, except Pump and Depth which use 0-3. Omit for Stroke."),
            strokeMin: z.number().int().min(0).max(100).optional().describe("Stroke minimum; only for Stroke."),
            strokeMax: z.number().int().min(0).max(100).optional().describe("Stroke maximum; only for Stroke and at least 20 above minimum."),
          }),
        ).min(1).max(5),
        durationSeconds: z.number().min(0).max(limits.maxCommandSeconds).refine((value) => value === 0 || value >= 2, "Use 0 or at least 2 seconds.")
          .describe("How long to run. Use 0 only when the user explicitly asks to continue until stopped."),
        deviceIds: z.array(z.string()).max(16).optional().describe("Specific device IDs. Omit to use every device authorized by the owner."),
        continueOtherFunctions: z.boolean().optional().default(false).describe("Keep functions from the previous command running on the same device."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    },
    async ({ actions, durationSeconds, deviceIds, continueOtherFunctions }) => {
      try {
        const validated = runtime.control(
          actions as FunctionAction[],
          durationSeconds,
          deviceIds || [],
          continueOtherFunctions,
        );
        const durationText = validated.durationSeconds === 0 ? "until stopped" : `for ${validated.durationSeconds} seconds`;
        return textResult(`Queued ${validated.action} ${durationText}.`, {
          accepted: true,
          action: validated.action,
          durationSeconds: validated.durationSeconds,
          deviceIds: validated.targetIds,
          warnings: validated.warnings,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lovense_adjust",
    {
      title: "Adjust Lovense relative to its last set level",
      description: "Use this to raise or lower one or more functions from the last level BLACKVOW set. If the level is unknown, establish it first with lovense_control.",
      inputSchema: {
        changes: z.array(z.object({
          function: functionSchema,
          delta: z.number().int().min(-20).max(20).refine((value) => value !== 0, "Delta cannot be zero."),
        })).min(1).max(5),
        durationSeconds: z.number().min(0).max(limits.maxCommandSeconds).refine((value) => value === 0 || value >= 2, "Use 0 or at least 2 seconds."),
        deviceIds: z.array(z.string()).max(16).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    },
    async ({ changes, durationSeconds, deviceIds }) => {
      try {
        const result = runtime.adjust(changes, deviceIds || [], durationSeconds);
        const durationText = durationSeconds === 0 ? "until stopped" : `for ${durationSeconds} seconds`;
        return textResult(`Queued a relative adjustment ${durationText}.`, {
          accepted: true,
          durationSeconds,
          deviceIds: result.targetIds,
          resultingActions: result.resultingActions,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lovense_run_routine",
    {
      title: "Run a multi-phase Lovense routine",
      description: "Use this when the owner asks for an authored sequence of control phases that must continue reliably between chat turns. A new control command or lovense_stop cancels it.",
      inputSchema: {
        phases: z.array(z.object({
          actions: z.array(z.object({
            function: functionSchema,
            intensity: z.number().int().min(0).max(20).optional(),
            strokeMin: z.number().int().min(0).max(100).optional(),
            strokeMax: z.number().int().min(0).max(100).optional(),
          })).min(1).max(5),
          durationSeconds: z.number().int().min(2).max(limits.maxCommandSeconds),
        })).min(1).max(24),
        repeat: z.number().int().min(1).max(50).optional().default(1),
        deviceIds: z.array(z.string()).max(16).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    },
    async ({ phases, repeat, deviceIds }) => {
      try {
        const result = runtime.startRoutine(phases as RoutinePhase[], repeat, deviceIds || []);
        return textResult(`Started a ${result.phaseCount}-phase routine for ${result.totalDurationSeconds} seconds.`, {
          accepted: true,
          ...result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lovense_play_pattern",
    {
      title: "Play a Lovense pattern",
      description: "Use this when the owner asks for a custom repeating intensity pattern on supported functions and selected devices.",
      inputSchema: {
        functions: z.array(patternFunctionSchema).min(1).max(8),
        strengths: z.array(z.number().int().min(0).max(20)).min(1).max(50),
        intervalMs: z.number().int().min(100).max(5000).default(1000),
        durationSeconds: z.number().min(0).max(limits.maxCommandSeconds).refine((value) => value === 0 || value >= 2, "Use 0 or at least 2 seconds."),
        deviceIds: z.array(z.string()).max(16).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    },
    async ({ functions, strengths, intervalMs, durationSeconds, deviceIds }) => {
      try {
        const ids = deviceIds || [];
        const selectedIds = safety.validatePattern(functions as LovenseFunction[], ids, client.status().deviceInfo);
        runtime.patternStarted();
        const shortNames: Record<string, string> = {
          Vibrate: "v", Rotate: "r", Pump: "p", Thrusting: "t", Fingering: "f", Suction: "s", Depth: "d", Oscillate: "o",
        };
        client.sendCommand(
          {
            command: "Pattern",
            rule: `V:1;F:${functions.map((fn) => shortNames[fn]).join(",")};S:${intervalMs}#`,
            strength: strengths.join(";"),
            timeSec: durationSeconds,
            apiVer: 2,
          },
          selectedIds,
        );
        const durationText = durationSeconds === 0 ? "until stopped" : `for ${durationSeconds} seconds`;
        return textResult(`Queued a pattern ${durationText} on ${selectedIds.length} device(s).`, {
          accepted: true, deviceIds: selectedIds, durationSeconds,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lovense_play_preset",
    {
      title: "Play a Lovense preset",
      description: "Use this when the owner asks for one of Lovense Remote's built-in pulse, wave, fireworks, or earthquake patterns.",
      inputSchema: {
        preset: z.enum(["pulse", "wave", "fireworks", "earthquake"]),
        durationSeconds: z.number().min(0).max(limits.maxCommandSeconds).refine((value) => value === 0 || value >= 2, "Use 0 or at least 2 seconds."),
        deviceIds: z.array(z.string()).max(16).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    },
    async ({ preset, durationSeconds, deviceIds }) => {
      try {
        const ids = safety.validatePattern([], deviceIds || [], client.status().deviceInfo);
        runtime.patternStarted();
        client.sendCommand({ command: "Preset", name: preset, timeSec: durationSeconds, apiVer: 1 }, ids);
        const durationText = durationSeconds === 0 ? "until stopped" : `for ${durationSeconds} seconds`;
        return textResult(`Queued the ${preset} preset ${durationText}.`, {
          accepted: true, preset, durationSeconds, deviceIds: ids,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lovense_stop",
    {
      title: "Stop Lovense immediately",
      description: "Use this whenever the user asks to stop, pause, cancel, or expresses discomfort.",
      inputSchema: {
        deviceIds: z.array(z.string()).max(16).optional().describe("Specific device IDs. Omit to stop every connected device."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ deviceIds }) => {
      try {
        const ids = deviceIds || [];
        runtime.stop(ids);
        return textResult("Lovense stop command queued.", { stopped: true, deviceIds: ids });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export class McpHttpHandler {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly runtime: ControlRuntime;

  constructor(
    private readonly client: LovenseClient,
    private readonly safety: SafetyController,
    private readonly limits: SafetyLimits,
  ) {
    this.runtime = new ControlRuntime(client, safety, limits);
  }

  async handle(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.headers["mcp-session-id"];
      const id = typeof sessionId === "string" ? sessionId : undefined;
      let entry = id ? this.sessions.get(id) : undefined;

      if (!entry && req.method === "POST" && !id && isInitializeRequest(req.body)) {
        let transport!: StreamableHTTPServerTransport;
        const server = createLovenseMcpServer(this.client, this.runtime, this.safety, this.limits);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            this.sessions.set(newId, { transport, server });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) this.sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        entry = { transport, server };
      }

      if (!entry) {
        res.status(id ? 404 : 400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: id ? "Unknown MCP session" : "Initialize the MCP session first" },
          id: null,
        });
        return;
      }
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal MCP error" }, id: null });
      }
      console.error("MCP request failed:", error instanceof Error ? error.message : "unknown error");
    }
  }

  async close(): Promise<void> {
    this.runtime.close();
    await Promise.all([...this.sessions.values()].map((entry) => entry.transport.close()));
    this.sessions.clear();
  }
}
