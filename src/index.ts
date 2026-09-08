import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import { loadConfig } from "./config.js";
import { LovenseClient } from "./lovense-client.js";
import { McpHttpHandler } from "./mcp-server.js";
import { OAuthService } from "./oauth.js";
import { SafetyController } from "./safety.js";
import { EncryptedStateStore } from "./state-store.js";

const config = loadConfig();
const publicHostname = new URL(config.publicBaseUrl).hostname;
const app = createMcpExpressApp({
  host: "0.0.0.0",
  allowedHosts: [...new Set([publicHostname, "localhost", "127.0.0.1", "[::1]"])],
});
const store = new EncryptedStateStore(config.stateFile, config.stateEncryptionKey);
const safety = new SafetyController(config.safety);
const lovense = new LovenseClient({
  developerToken: config.lovenseDeveloperToken,
  uid: config.lovenseUid,
  platformName: config.lovensePlatformName,
  store,
});
const mcp = new McpHttpHandler(lovense, safety, config.safety);
const oauth = new OAuthService(config.publicBaseUrl, config.oauthSigningKey);

function secureEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function bearer(req: Request): string {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

const failedAuth = new Map<string, { count: number; resetAt: number }>();
function authBlocked(key: string): boolean {
  const attempt = failedAuth.get(key);
  return Boolean(attempt && attempt.resetAt > Date.now() && attempt.count >= 8);
}

function authFailed(key: string): void {
  const now = Date.now();
  const previous = failedAuth.get(key);
  const current = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + 10 * 60_000 };
  current.count += 1;
  failedAuth.set(key, current);
}

function ownerAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || "unknown";
  if (authBlocked(key)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  if (!secureEqual(bearer(req), config.ownerSecret)) {
    authFailed(key);
    res.status(401).json({ error: "Owner key is not valid." });
    return;
  }
  failedAuth.delete(key);
  res.setHeader("cache-control", "no-store");
  next();
}

function secretPathAuth(req: Request, res: Response, next: NextFunction): void {
  const pathSecret = typeof req.params.secret === "string" ? req.params.secret : "";
  if (secureEqual(pathSecret, config.mcpPathSecret)) {
    res.setHeader("cache-control", "no-store");
    next();
    return;
  }
  res.status(404).send("Not found");
}

function oauthMcpAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    oauth.verifyAccess(bearer(req));
    res.setHeader("cache-control", "no-store");
    next();
  } catch {
    res.setHeader(
      "www-authenticate",
      `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", scope="lovense:control"`,
    );
    res.status(401).json({ error: "OAuth authorization is required." });
  }
}

function inputStrings(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? String(item[0] || "") : String(item || "")]));
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}

type UiLanguage = "es" | "en";

function requestLanguage(req: Request): UiLanguage {
  const cookieLanguage = (req.headers.cookie || "").match(/(?:^|;\s*)lilazul-language=(es|en)(?:;|$)/)?.[1];
  if (cookieLanguage === "es" || cookieLanguage === "en") return cookieLanguage;
  return (req.headers["accept-language"] || "").toLowerCase().startsWith("es") ? "es" : "en";
}

function authorizePage(fields: Record<string, string>, error = "", language: UiLanguage = "en"): string {
  const hidden = Object.entries(fields)
    .filter(([name]) => name !== "owner_secret" && name !== "decision")
    .map(([name, value]) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`).join("");
  const copy = language === "es"
    ? { title: "Autorizar BLACKVOW", heading: "¿Conectar BLACKVOW a ChatGPT?", intro: "ChatGPT solicita permiso para detectar y controlar los dispositivos Lovense que tú conectes a Lovense Remote. Si el juguete está apagado o desconectado, no podrá actuar.", label: "Tu Owner Key", approve: "Autorizar mi ChatGPT", deny: "Cancelar", note: "La clave se envía solo a tu propia instancia de Railway mediante HTTPS." }
    : { title: "Authorize BLACKVOW", heading: "Connect BLACKVOW to ChatGPT?", intro: "ChatGPT is requesting permission to detect and control the Lovense devices you connect to Lovense Remote. If the toy is turned off or disconnected, it cannot be controlled.", label: "Your Owner Key", approve: "Authorize my ChatGPT", deny: "Cancel", note: "The key is sent only to your own Railway instance over HTTPS." };
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title><style>color-scheme:dark;*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#35205f,#0d0a18 55%);color:#f8f5ff;font:16px/1.5 system-ui}.card{width:min(480px,100%);padding:28px;border-radius:24px;background:#17112bd9;border:1px solid #ffffff22;box-shadow:0 24px 80px #0007}h1{margin-top:0;color:#c5a9ff}label{display:block;color:#c9c0dc;margin:18px 0 7px}input,button{width:100%;padding:13px;border-radius:12px;border:1px solid #ffffff2d;background:#0e0a1d;color:#fff;font:inherit}button{margin-top:12px;background:linear-gradient(135deg,#704dc5,#287b9e);font-weight:700;cursor:pointer}.deny{background:#251d38}.error{color:#ff9ab0}.small{color:#bdb4d3;font-size:.9rem}</style></head><body><main class="card"><h1>${copy.heading}</h1><p>${copy.intro}</p>${error ? `<p class="error">${html(error)}</p>` : ""}<form method="post" action="/oauth/authorize">${hidden}<label for="owner_secret">${copy.label}</label><input id="owner_secret" name="owner_secret" type="password" autocomplete="current-password" required><button name="decision" value="approve">${copy.approve}</button><button class="deny" name="decision" value="deny">${copy.deny}</button></form><p class="small">${copy.note}</p></main></body></html>`;
}

app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.use("/guides", express.static(join(process.cwd(), "public", "guides"), {
  dotfiles: "deny",
  fallthrough: false,
  setHeaders: (res, filePath) => {
    res.setHeader("content-disposition", `attachment; filename="${filePath.endsWith("_ES.docx") ? "Lilazul_Lovense_Guia_ES.docx" : "Lilazul_Lovense_Guide_EN.docx"}"`);
    res.setHeader("cache-control", "public, max-age=3600");
  },
}));

app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(oauth.protectedResourceMetadata()));
app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(oauth.protectedResourceMetadata()));
app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(oauth.metadata()));
app.get("/.well-known/openid-configuration", (_req, res) => res.json(oauth.metadata()));

app.post("/oauth/register", (req, res) => {
  try {
    res.status(201).json(oauth.registerClient(req.body?.redirect_uris));
  } catch (error) {
    res.status(400).json({ error: "invalid_redirect_uri", error_description: error instanceof Error ? error.message : "Invalid registration." });
  }
});

app.get("/oauth/authorize", (req, res) => {
  const fields = inputStrings(req.query as Record<string, unknown>);
  const language = requestLanguage(req);
  try {
    oauth.validateAuthorization(fields);
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'");
    res.send(authorizePage(fields, "", language));
  } catch (error) {
    res.status(400).send(authorizePage(fields, error instanceof Error ? error.message : language === "es" ? "Solicitud de autorización no válida." : "Invalid authorization request.", language));
  }
});

app.post("/oauth/authorize", (req, res) => {
  const fields = inputStrings(req.body || {});
  const redirectUri = fields.redirect_uri;
  const authKey = req.ip || "unknown";
  const language = requestLanguage(req);
  try {
    oauth.validateAuthorization(fields);
    const redirect = new URL(redirectUri || "");
    if (fields.decision !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      if (fields.state) redirect.searchParams.set("state", fields.state);
      res.redirect(303, redirect.toString());
      return;
    }
    if (authBlocked(authKey)) {
      res.status(429).send(authorizePage(fields, language === "es" ? "Demasiados intentos. Espera unos minutos." : "Too many attempts. Wait a few minutes.", language));
      return;
    }
    if (!secureEqual(fields.owner_secret || "", config.ownerSecret)) {
      authFailed(authKey);
      res.status(401).send(authorizePage(fields, language === "es" ? "La Owner Key no es correcta." : "The Owner Key is not correct.", language));
      return;
    }
    failedAuth.delete(authKey);
    redirect.searchParams.set("code", oauth.createAuthorizationCode(fields));
    if (fields.state) redirect.searchParams.set("state", fields.state);
    res.redirect(303, redirect.toString());
  } catch (error) {
    res.status(400).send(authorizePage(fields, error instanceof Error ? error.message : language === "es" ? "La autorización ha fallado." : "Authorization failed.", language));
  }
});

app.post("/oauth/token", (req, res) => {
  const fields = inputStrings(req.body || {});
  try {
    const result = fields.grant_type === "refresh_token" ? oauth.refresh(fields) : oauth.exchangeCode(fields);
    res.setHeader("cache-control", "no-store");
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: "invalid_grant", error_description: error instanceof Error ? error.message : "Token exchange failed." });
  }
});

app.get("/", (_req, res) => {
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' https://*.lovense.com https://*.lovense-api.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.sendFile(join(process.cwd(), "public", "index.html"));
});

app.get("/api/admin/status", ownerAuth, (_req, res) => {
  const status = lovense.status();
  res.json({
    connectionState: status.connectionState,
    connectionError: status.lastError,
    deviceInfo: status.deviceInfo,
    mcpUrl: `${config.publicBaseUrl}/mcp`,
  });
});

app.post("/api/admin/qr", ownerAuth, async (_req, res) => {
  try {
    res.json(await lovense.getQrCode());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Could not create the QR code." });
  }
});

app.post("/api/admin/stop", ownerAuth, (_req, res) => {
  try {
    lovense.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, []);
    res.json({ stopped: true });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "The stop command could not be delivered." });
  }
});

for (const method of ["get", "post", "delete"] as const) {
  app[method]("/:secret/mcp", secretPathAuth, (req, res) => void mcp.handle(req, res));
  app[method]("/mcp", oauthMcpAuth, (req, res) => void mcp.handle(req, res));
}

const httpServer = app.listen(config.port, "0.0.0.0", () => {
  console.log(`BLACKVOW connector listening on port ${config.port}.`);
});

lovense.start().catch((error) => {
  console.error("Lovense startup failed:", error instanceof Error ? error.message : "unknown error");
});

async function shutdown(): Promise<void> {
  try {
    lovense.sendCommand({ command: "Function", action: "Stop", timeSec: 0, apiVer: 1 }, []);
  } catch {
    // The service may already be disconnected during shutdown.
  }
  lovense.close();
  await mcp.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
