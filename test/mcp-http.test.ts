import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpHttpHandler } from "../src/mcp-server.js";

test("MCP initializes and publishes the safety-first tool surface", async () => {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const fakeClient = {
    status: () => ({ connectionState: "connected", lastError: "", deviceInfo: null }),
    sendCommand: () => undefined,
  };
  const limits = { maxCommandSeconds: 7200 };
  const handler = new McpHttpHandler(fakeClient as never, limits);
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
    for (const name of [
      "lovense_status", "lovense_list_devices", "lovense_configure_device", "lovense_preview",
      "lovense_live_status", "lovense_live_start", "lovense_live_adjust", "lovense_live_extend",
      "lovense_hold", "lovense_resume", "lovense_stop_device", "lovense_stop_all",
    ]) {
      assert.match(body, new RegExp(name));
    }
    assert.match(body, /default one-hour live-session window/);
    assert.match(body, /"durationSeconds":\{"default":3600,[^}]+"maximum":7200\}/);
    assert.match(body, /"function"[^}]+"const":"Stroke"/);
    assert.match(body, /"required":\["function","strokeMin","strokeMax"\]/);
    assert.match(body, /"additionalProperties":false/);
    assert.match(body, /patternTracks/);
    assert.match(body, /"const":"build_deny"/);
    assert.match(body, /never send Lovense Pattern commands/);
  } finally {
    await handler.close();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
});
