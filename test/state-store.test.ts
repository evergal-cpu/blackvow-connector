import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EncryptedStateStore } from "../src/state-store.js";

test("persists device state encrypted and rejects the wrong key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilazul-lovense-test-"));
  const path = join(directory, "state.enc");
  try {
    const store = new EncryptedStateStore(path, "a very long encryption secret for tests");
    const state = {
      version: 1 as const,
      deviceInfo: {
        online: true, appType: "remote", appVersion: "7", platform: "ios", updatedAt: new Date().toISOString(),
        toys: [{ id: "private-device-id", name: "Ferri", toyType: "ferri", nickname: "mine", battery: 99, connected: true, capabilities: ["Vibrate" as const], capabilitySource: "catalog" as const }],
      },
    };
    await store.save(state);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("private-device-id"), false);
    assert.deepEqual(await store.load(), state);
    await assert.rejects(
      () => new EncryptedStateStore(path, "a different long encryption secret").load(),
      /Could not decrypt/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("serializes concurrent saves and preserves the final state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilazul-lovense-concurrent-test-"));
  const path = join(directory, "state.enc");
  try {
    const store = new EncryptedStateStore(path, "another very long encryption secret for tests");
    const states = Array.from({ length: 50 }, (_, index) => ({
      version: 2 as const,
      deviceInfo: {
        online: true,
        appType: "remote",
        appVersion: "7",
        platform: "ios",
        updatedAt: `2026-10-07T00:00:${String(index).padStart(2, "0")}Z`,
        toys: [],
      },
      deviceProfiles: [],
    }));

    await Promise.all(states.map((state) => store.save(state)));

    assert.deepEqual(await store.load(), states.at(-1));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
