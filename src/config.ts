import { resolve } from "node:path";
import { MAX_LIVE_SESSION_SECONDS, type AppConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function secret(name: string): string {
  const value = required(name);
  if (value.length < 24) {
    throw new Error(`${name} must contain at least 24 characters`);
  }
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const ownerSecret = secret("OWNER_SECRET");
  const mcpPathSecret = secret("MCP_PATH_SECRET");
  const stateEncryptionKey = secret("STATE_ENCRYPTION_KEY");
  const oauthSigningKey = secret("OAUTH_SIGNING_KEY");
  if (new Set([ownerSecret, mcpPathSecret, stateEncryptionKey, oauthSigningKey]).size !== 4) {
    throw new Error("OWNER_SECRET, MCP_PATH_SECRET, STATE_ENCRYPTION_KEY and OAUTH_SIGNING_KEY must be different");
  }

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const publicBaseUrl = (
    process.env.PUBLIC_BASE_URL?.trim() ||
    (railwayDomain ? `https://${railwayDomain}` : "http://localhost:3000")
  ).replace(/\/$/, "");

  return {
    port: integer("PORT", 3000, 1, 65535),
    publicBaseUrl,
    lovenseDeveloperToken: required("LOVENSE_DEVELOPER_TOKEN"),
    lovensePlatformName: required("LOVENSE_PLATFORM_NAME"),
    lovenseUid: process.env.LOVENSE_UID?.trim() || "owner",
    ownerSecret,
    mcpPathSecret,
    oauthSigningKey,
    stateEncryptionKey,
    stateFile: resolve(process.env.STATE_FILE?.trim() || ".data/lovense-state.enc"),
    safety: {
      maxCommandSeconds: integer("MAX_COMMAND_SECONDS", MAX_LIVE_SESSION_SECONDS, 2, MAX_LIVE_SESSION_SECONDS),
    },
  };
}
