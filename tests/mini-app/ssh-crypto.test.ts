import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPassphrase } from "../../mini-app/src/ssh-crypto.js";

describe("SSH Mini App encryption", () => {
  it("creates a fresh AES-GCM envelope wrapped with RSA-OAEP", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicDer = publicKey.export({ type: "spki", format: "der" }).toString("base64url");

    const envelope = await encryptPassphrase(
      publicDer,
      "key-1",
      "request-1",
      1_700_000_100,
      "secret passphrase",
    );
    const aesKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(envelope.wrappedKey, "base64url"),
    );

    expect(envelope.version).toBe(1);
    expect(envelope.nonce).toHaveLength(16);
    expect(aesKey).toHaveLength(32);
    expect(envelope.ciphertext).not.toBe("");
  });
});
