import type { SshUnlockEnvelope } from "./ssh-types.js";

export async function encryptPassphrase(
  publicKey: string,
  keyId: string,
  requestId: string,
  expiresAt: number,
  passphrase: string,
): Promise<SshUnlockEnvelope> {
  const rsaKey = await crypto.subtle.importKey(
    "spki",
    decodeBase64Url(publicKey),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
  ]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    new TextEncoder().encode(passphrase),
  );
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaKey, rawAesKey);

  return {
    version: 1,
    keyId,
    requestId,
    expiresAt,
    nonce: encodeBase64Url(nonce),
    wrappedKey: encodeBase64Url(new Uint8Array(wrappedKey)),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
