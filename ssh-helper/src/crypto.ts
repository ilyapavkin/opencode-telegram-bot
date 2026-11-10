import fs from "node:fs";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  constants,
  verify,
  type KeyObject,
} from "node:crypto";
import type { HelperConfig, SignedRequest, UnlockEnvelope } from "./types.js";

export interface EncryptionKeys {
  privateKey: KeyObject;
  publicKey: string;
  keyId: string;
}

export function loadEncryptionKeys(config: HelperConfig): EncryptionKeys {
  const privateKey = createPrivateKey(fs.readFileSync(config.encryptionKeyFile));
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return {
    privateKey,
    publicKey: Buffer.from(publicDer).toString("base64url"),
    keyId: createHash("sha256").update(publicDer).digest("hex").slice(0, 32),
  };
}

export function loadSigningPublicKey(config: HelperConfig): KeyObject {
  return createPublicKey(fs.readFileSync(config.botSigningPublicKeyFile));
}

export function verifySignedRequest(
  signedRequest: SignedRequest,
  signature: string,
  publicKey: KeyObject,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(JSON.stringify(signedRequest)),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function decryptPassphrase(envelope: UnlockEnvelope, keys: EncryptionKeys): Buffer {
  if (
    envelope.version !== 1 ||
    envelope.keyId !== keys.keyId ||
    !isBase64Url(envelope.nonce, 12) ||
    !isBase64Url(envelope.wrappedKey) ||
    !isBase64Url(envelope.ciphertext)
  ) {
    throw new Error("Invalid encryption envelope");
  }

  const aesKey = privateDecrypt(
    {
      key: keys.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    decodeBase64Url(envelope.wrappedKey),
  );
  if (aesKey.byteLength !== 32) throw new Error("Invalid encrypted key");

  const ciphertext = decodeBase64Url(envelope.ciphertext);
  if (ciphertext.byteLength < 16) throw new Error("Invalid encrypted passphrase");
  const nonce = decodeBase64Url(envelope.nonce);
  const tag = ciphertext.subarray(-16);
  const content = ciphertext.subarray(0, -16);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(tag);
  const passphrase = Buffer.concat([decipher.update(content), decipher.final()]);
  aesKey.fill(0);
  return passphrase;
}

function isBase64Url(value: string, exactBytes?: number): boolean {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  return exactBytes === undefined || Math.ceil((value.length * 6) / 8) === exactBytes;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
