export interface SshHelperPublicKey {
  keyId: string;
  publicKey: string;
}

export type SshHelperState = "locked" | "unlocked";

export interface SshHelperStatus {
  state: SshHelperState;
  keyId: string;
  fingerprint: string | null;
}

export interface SshUnlockEnvelope {
  version: 1;
  keyId: string;
  requestId: string;
  expiresAt: number;
  nonce: string;
  wrappedKey: string;
  ciphertext: string;
}

export interface SshUnlockAuthorization {
  requestId: string;
  authorizationToken: string;
  keyId: string;
  publicKey: string;
  expiresAt: number;
}
