export const LOVENSE_FUNCTIONS = [
  "Vibrate",
  "Rotate",
  "Pump",
  "Thrusting",
  "Fingering",
  "Suction",
  "Depth",
  "Stroke",
  "Oscillate",
] as const;

export type LovenseFunction = (typeof LOVENSE_FUNCTIONS)[number];

export const DEFAULT_LIVE_SESSION_SECONDS = 3_600;
export const MAX_LIVE_SESSION_SECONDS = 7_200;

export type CapabilitySource = "device" | "catalog" | "unknown";

export interface ToyDevice {
  id: string;
  name: string;
  toyType: string;
  nickname: string;
  battery: number;
  connected: boolean;
  capabilities: LovenseFunction[];
  capabilitySource: CapabilitySource;
}

export interface LovenseDeviceInfo {
  online: boolean;
  appType: string;
  appVersion: string;
  platform: string;
  updatedAt: string;
  toys: ToyDevice[];
}

export interface PersistedState {
  version: 1 | 2;
  deviceInfo: LovenseDeviceInfo | null;
  deviceProfiles?: DeviceControlProfile[];
}

export interface FunctionAction {
  function: LovenseFunction;
  intensity?: number;
  strokeMin?: number;
  strokeMax?: number;
}

export interface SafetyLimits {
  maxCommandSeconds: number;
}

export type AttachmentProfile = "straight" | "g_curve";

export interface ManualOrAppFeature {
  feature: "Heat" | "Turbo";
  blackvowControllable: false;
  availableForCurrentAttachment: boolean | null;
  attachmentSupport: Record<AttachmentProfile, "supported" | "unsupported" | "unverified">;
  source: "manufacturer_documentation" | "manufacturer_app";
}

export interface DeviceControlProfile {
  deviceId: string;
  alias: string;
  attachment?: AttachmentProfile;
  ceilings: Partial<Record<LovenseFunction, number>>;
}

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  lovenseDeveloperToken: string;
  lovensePlatformName: string;
  lovenseUid: string;
  ownerSecret: string;
  mcpPathSecret: string;
  oauthSigningKey: string;
  stateEncryptionKey: string;
  stateFile: string;
  safety: SafetyLimits;
}
