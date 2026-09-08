import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpHttpHandler } from "../src/mcp-server.js";
import { SafetyController } from "../src/safety.js";

test("MCP initializes and publishes the safety-first tool surface", async () => {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const fakeClient = {
    status: () => ({ connectionState: "connected", lastError: "", deviceInfo: null }),
    sendCommand: () => undefined,
  };
  const limits = { maxCommandSeconds: 3600 };
  const handler = new McpHttpHandler(fakeClient as never, new SafetyController(limits), limits);
  app.all("/mcp", (req, res) => void handler.handle(req, res));
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const { port } = http.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  try {
    const initialize = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const sessionHeaders = { ...headers, "mcp-session-id": sessionId };
    const initialized = await fetch(endpoint, {
      method: "POST", headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.ok([200, 202].includes(initialized.status));

    const tools = await fetch(endpoint, {
      method: "POST", headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const body = await tools.text();
    assert.equal(tools.status, 200);
    for (const name of ["lovense_status", "lovense_list_devices", "lovense_control", "lovense_adjust", "lovense_run_routine", "lovense_play_pattern", "lovense_play_preset", "lovense_stop"]) {
      assert.match(body, new RegExp(name));
    }
  } finally {
    await handler.close();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
});
