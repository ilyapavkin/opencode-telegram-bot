export interface HelperConfig {
  bindHost: string;
  port: number;
  sshKeyPath: string;
  agentSocket: string;
  encryptionKeyFile: string;
  botSigningPublicKeyFile: string;
  allowedTraefikAddress: string;
}

export interface UnlockEnvelope {
  version: 1;
  keyId: string;
  requestId: string;
  expiresAt: number;
  nonce: string;
  wrappedKey: string;
  ciphertext: string;
}

export interface HelperStatus {
  state: "locked" | "unlocked";
  keyId: string;
  fingerprint: string | null;
}

export interface SignedRequest {
  operation: "public_key" | "status" | "unlock" | "lock";
  requestId: string;
  expiresAt: number;
  body: unknown;
}
