export interface SshPublicKeyResponse {
  keyId: string;
  publicKey: string;
}

export interface SshStatusResponse {
  state: "locked" | "unlocked";
  keyId: string;
  fingerprint: string | null;
}

export interface SshAuthorizationResponse extends SshPublicKeyResponse {
  requestId: string;
  authorizationToken: string;
  expiresAt: number;
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

export class SshApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SshApiError";
  }
}
