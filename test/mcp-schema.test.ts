import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { actionSchema } from "../src/mcp-server.js";

test("non-Stroke actions require an integer intensity in their native range", () => {
  for (const fn of ["Vibrate", "Rotate", "Thrusting", "Fingering", "Suction", "Oscillate"] as const) {
    assert.equal(actionSchema.safeParse({ function: fn, intensity: 20 }).success, true);
    assert.equal(actionSchema.safeParse({ function: fn }).success, false);
    assert.equal(actionSchema.safeParse({ function: fn, intensity: 20.5 }).success, false);
    assert.equal(actionSchema.safeParse({ function: fn, intensity: 21 }).success, false);
  }
  for (const fn of ["Pump", "Depth"] as const) {
    assert.equal(actionSchema.safeParse({ function: fn, intensity: 3 }).success, true);
    assert.equal(actionSchema.safeParse({ function: fn }).success, false);
    assert.equal(actionSchema.safeParse({ function: fn, intensity: 4 }).success, false);
  }
});

test("Stroke requires only strokeMin and strokeMax with a valid gap", () => {
  assert.equal(actionSchema.safeParse({ function: "Stroke", strokeMin: 10, strokeMax: 30 }).success, true);
  assert.equal(actionSchema.safeParse({ function: "Stroke", strokeMin: 10, strokeMax: 29 }).success, false);
  assert.equal(actionSchema.safeParse({ function: "Stroke", intensity: 10, strokeMin: 0, strokeMax: 20 }).success, false);
  assert.equal(actionSchema.safeParse({ function: "Vibrate", intensity: 2, strokeMin: 0 }).success, false);
});

test("published action JSON Schema is a strict discriminated union", () => {
  const schema = z.toJSONSchema(actionSchema) as {
    oneOf?: Array<{
      additionalProperties?: boolean;
      properties?: { function?: { const?: string }; intensity?: { maximum?: number } };
      required?: string[];
    }>;
  };
  assert.equal(schema.oneOf?.length, 9);
  const vibrate = schema.oneOf?.find((entry) => entry.properties?.function?.const === "Vibrate");
  const pump = schema.oneOf?.find((entry) => entry.properties?.function?.const === "Pump");
  const stroke = schema.oneOf?.find((entry) => entry.properties?.function?.const === "Stroke");
  assert.deepEqual(vibrate?.required, ["function", "intensity"]);
  assert.equal(vibrate?.properties?.intensity?.maximum, 20);
  assert.equal(pump?.properties?.intensity?.maximum, 3);
  assert.deepEqual(stroke?.required, ["function", "strokeMin", "strokeMax"]);
  assert.equal(stroke?.additionalProperties, false);
});
