import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  constants,
} from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptPassphrase, loadEncryptionKeys } from "../src/crypto.js";
import type { HelperConfig } from "../src/types.js";

test("decrypts a browser-compatible RSA-OAEP and AES-GCM envelope", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-helper-crypto-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = path.join(directory, "encryption.pem");
  await fs.writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const config = {
    encryptionKeyFile: keyPath,
  } as HelperConfig;
  const keys = loadEncryptionKeys(config);
  const passphrase = Buffer.from("correct horse battery staple");
  const nonce = randomBytes(12);
  const aesKey = randomBytes(32);
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(passphrase),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const wrappedKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    aesKey,
  );

  const decrypted = decryptPassphrase(
    {
      version: 1,
      keyId: keys.keyId,
      requestId: "request-1",
      expiresAt: 1_700_000_000,
      nonce: nonce.toString("base64url"),
      wrappedKey: wrappedKey.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    },
    keys,
  );

  assert.deepEqual(decrypted, passphrase);
  decrypted.fill(0);
  passphrase.fill(0);
  aesKey.fill(0);
  await fs.rm(directory, { recursive: true, force: true });
});
