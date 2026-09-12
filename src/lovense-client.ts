import { randomUUID } from "node:crypto";
import io from "socket.io-client";
import { normalizeToy } from "./capabilities.js";
import { EncryptedStateStore } from "./state-store.js";
import type { DeviceControlProfile, LovenseDeviceInfo, PersistedState } from "./types.js";

interface LovenseClientOptions {
  developerToken: string;
  uid: string;
  platformName: string;
  store: EncryptedStateStore;
}

type SocketLike = ReturnType<typeof io>;

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Lovense request failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as Record<string, unknown>;
  if (Number(payload.code) !== 0) throw new Error(String(payload.message || "Lovense rejected the request."));
  return payload;
}

export class LovenseClient {
  private socket: SocketLike | null = null;
  private deviceInfo: LovenseDeviceInfo | null = null;
  private connectionState: "starting" | "connected" | "disconnected" | "error" = "starting";
  private lastError = "";
  private readonly deviceProfiles = new Map<string, DeviceControlProfile>();

  constructor(private readonly options: LovenseClientOptions) {}

  async start(): Promise<void> {
    const saved = await this.options.store.load();
    this.deviceInfo = saved?.deviceInfo || null;
    for (const profile of saved?.deviceProfiles || []) this.deviceProfiles.set(profile.deviceId, profile);
    try {
      const tokenResult = await postJson("https://api.lovense-api.com/api/basicApi/getToken", {
        token: this.options.developerToken,
        uid: this.options.uid,
        uname: "Owner",
      });
      const tokenData = (tokenResult.data || {}) as Record<string, unknown>;
      const authToken = String(tokenData.authToken || "");
      if (!authToken) throw new Error("Lovense did not return an authorization token.");
      const socketResult = await postJson("https://api.lovense-api.com/api/basicApi/getSocketUrl", {
        platform: this.options.platformName,
        authToken,
      });
      const socketData = (socketResult.data || {}) as Record<string, unknown>;
      const socketIoUrl = String(socketData.socketIoUrl || "");
      const socketIoPath = String(socketData.socketIoPath || "");
      if (!socketIoUrl || !socketIoPath) throw new Error("Lovense did not return socket connection details.");
      this.connectSocket(socketIoUrl, socketIoPath);
    } catch (error) {
      this.connectionState = "error";
      this.lastError = error instanceof Error ? error.message : "Unknown Lovense connection error";
      throw error;
    }
  }

  private connectSocket(url: string, path: string): void {
    this.socket?.close();
    this.socket = io(url, {
      path,
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 15_000,
    });
    this.socket.on("connect", () => {
      this.connectionState = "connected";
      this.lastError = "";
    });
    this.socket.on("disconnect", () => {
      this.connectionState = "disconnected";
    });
    this.socket.on("connect_error", (error: Error) => {
      this.connectionState = "error";
      this.lastError = error.message;
    });
    this.socket.on("basicapi_update_device_info_tc", (value: unknown) => {
      void this.updateDeviceInfo(parsePayload(value));
    });
    this.socket.on("basicapi_update_app_online_tc", (value: unknown) => {
      const payload = parsePayload(value);
      if (this.deviceInfo && typeof payload.online === "boolean") {
        this.deviceInfo.online = payload.online;
        this.deviceInfo.updatedAt = new Date().toISOString();
        void this.persist();
      }
    });
  }

  private async updateDeviceInfo(payload: Record<string, unknown>): Promise<void> {
    const rawList = Array.isArray(payload.toyList)
      ? payload.toyList
      : payload.toys && typeof payload.toys === "object"
        ? Object.values(payload.toys as Record<string, unknown>)
        : [];
    const toys = rawList
      .map((value) => normalizeToy(parsePayload(value)))
      .filter((value) => value !== null);
    this.deviceInfo = {
      online: payload.online !== false,
      appType: String(payload.appType || "remote"),
      appVersion: String(payload.appVersion || ""),
      platform: String(payload.platform || ""),
      updatedAt: new Date().toISOString(),
      toys,
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    const state: PersistedState = { version: 2, deviceInfo: this.deviceInfo, deviceProfiles: [...this.deviceProfiles.values()] };
    await this.options.store.save(state);
  }

  controlProfiles(): DeviceControlProfile[] {
    return [...this.deviceProfiles.values()].map((profile) => ({ ...profile, ceilings: { ...profile.ceilings } }));
  }

  setControlProfile(profile: DeviceControlProfile): void {
    this.deviceProfiles.set(profile.deviceId, { ...profile, ceilings: { ...profile.ceilings } });
    void this.persist().catch((error) => {
      this.lastError = error instanceof Error ? error.message : "Could not persist the device profile.";
    });
  }

  status(): { connectionState: string; lastError: string; deviceInfo: LovenseDeviceInfo | null } {
    return { connectionState: this.connectionState, lastError: this.lastError, deviceInfo: this.deviceInfo };
  }

  async getQrCode(): Promise<{ qrcodeUrl: string; qrcode: string }> {
    if (!this.socket?.connected) throw new Error("The Lovense service is not connected yet. Try again in a moment.");
    const socket = this.socket;
    const ackId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.removeListener("basicapi_get_qrcode_tc", listener);
        reject(new Error("Lovense did not return a QR code in time."));
      }, 15_000);
      const listener = (value: unknown) => {
        const payload = parsePayload(value);
        const data = (payload.data || {}) as Record<string, unknown>;
        if (String(data.ackId || "") !== ackId) return;
        clearTimeout(timeout);
        socket.removeListener("basicapi_get_qrcode_tc", listener);
        if (Number(payload.code) !== 0) {
          reject(new Error(String(payload.message || "Lovense could not create the QR code.")));
          return;
        }
        resolve({ qrcodeUrl: String(data.qrcodeUrl || ""), qrcode: String(data.qrcode || "") });
      };
      socket.on("basicapi_get_qrcode_tc", listener);
      socket.emit("basicapi_get_qrcode_ts", { ackId });
    });
  }

  sendCommand(command: Record<string, unknown>, targetIds: string[]): void {
    if (!this.socket?.connected) throw new Error("Lovense Remote is offline or the server connection is unavailable.");
    if (targetIds.length === 0) {
      this.socket.emit("basicapi_send_toy_command_ts", command);
      return;
    }
    // One command per toy also works with Remote versions older than array targeting support.
    for (const id of targetIds) {
      this.socket.emit("basicapi_send_toy_command_ts", { ...command, toy: id });
    }
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
