import { LOVENSE_FUNCTIONS, type LovenseFunction, type ToyDevice } from "./types.js";

const SHORT_NAMES: Record<string, LovenseFunction> = {
  v: "Vibrate",
  r: "Rotate",
  p: "Pump",
  t: "Thrusting",
  f: "Fingering",
  s: "Suction",
  d: "Depth",
  o: "Oscillate",
};

// Conservative fallback for devices whose socket payload does not announce functions.
// Live fullFunctionNames/shortFunctionNames always take precedence when available.
const CATALOG: Array<[RegExp, LovenseFunction[]]> = [
  [/^(nora)/i, ["Vibrate", "Rotate"]],
  [/^(ridge)/i, ["Vibrate", "Rotate"]],
  [/^(max|max2|max 2)/i, ["Vibrate", "Pump"]],
  [/^(tenera|tenera2|tenera 2)/i, ["Suction"]],
  [/^(osci|osci2|osci3|osci 2|osci 3)/i, ["Vibrate", "Fingering"]],
  [/^(gush2|gush 2)/i, ["Vibrate", "Oscillate"]],
  [/^(velvo)/i, ["Vibrate", "Rotate", "Oscillate"]],
  [/^(vulse)/i, ["Vibrate", "Thrusting"]],
  [/^(solace|solace pro|gravity|sex machine|mini sex machine)/i, ["Thrusting", "Stroke", "Depth"]],
  [/^(spinel)/i, ["Vibrate", "Thrusting"]],
  [
    /^(ferri|lush|hush|domi|gemini|flexer|mission|dolce|ambi|lapis|exomoon|hyphy|edge|synth)/i,
    ["Vibrate"],
  ],
];

function normalizeFunction(value: unknown): LovenseFunction | null {
  if (typeof value !== "string") return null;
  const direct = LOVENSE_FUNCTIONS.find((entry) => entry.toLowerCase() === value.toLowerCase());
  return direct || SHORT_NAMES[value.toLowerCase()] || null;
}

export function detectCapabilities(raw: Record<string, unknown>): Pick<ToyDevice, "capabilities" | "capabilitySource"> {
  const announced = [raw.fullFunctionNames, raw.shortFunctionNames]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(normalizeFunction)
    .filter((value): value is LovenseFunction => Boolean(value));

  if (announced.length > 0) {
    return { capabilities: [...new Set(announced)], capabilitySource: "device" };
  }

  const identity = [raw.toyType, raw.name].filter((value) => typeof value === "string").join(" ");
  for (const [pattern, capabilities] of CATALOG) {
    if (pattern.test(identity)) return { capabilities, capabilitySource: "catalog" };
  }
  return { capabilities: [], capabilitySource: "unknown" };
}

export function normalizeToy(raw: Record<string, unknown>): ToyDevice | null {
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const detected = detectCapabilities(raw);
  const connectedValue = raw.connected ?? raw.status;
  return {
    id,
    name: String(raw.name || raw.toyType || "Lovense"),
    toyType: String(raw.toyType || raw.name || "unknown").toLowerCase(),
    nickname: String(raw.nickname || raw.nickName || ""),
    battery: Number.isFinite(Number(raw.battery)) ? Number(raw.battery) : -1,
    connected: connectedValue === true || connectedValue === 1 || connectedValue === "1",
    ...detected,
  };
}
