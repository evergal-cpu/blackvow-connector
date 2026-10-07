import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PersistedState } from "./types.js";

interface Envelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedStateStore {
  private readonly key: Buffer;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, secret: string) {
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  async load(): Promise<PersistedState | null> {
    try {
      const envelope = JSON.parse(await readFile(this.filePath, "utf8")) as Envelope;
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as PersistedState;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new Error("Could not decrypt saved Lovense state. Check STATE_ENCRYPTION_KEY.", { cause: error });
    }
  }

  save(state: PersistedState): Promise<void> {
    const serializedState = JSON.stringify(state);
    const operation = this.saveQueue.then(() => this.writeState(serializedState));
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }

  private async writeState(serializedState: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(serializedState, "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
