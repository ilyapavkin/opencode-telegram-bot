import fs from "node:fs";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { config } from "../../config.js";
import type { SshHelperPublicKey, SshHelperStatus, SshUnlockEnvelope } from "../types/ssh.js";

const REQUEST_TIMEOUT_MS = 10_000;

export class SshHelperClientError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "SshHelperClientError";
  }
}

type FetchImplementation = typeof fetch;

interface SignedRequestBody {
  operation: "public_key" | "status" | "unlock" | "lock";
  requestId: string;
  expiresAt: number;
  body: unknown;
}

export interface SshHelperClientOptions {
  fetch?: FetchImplementation;
  signingKey?: ReturnType<typeof createPrivateKey>;
  now?: () => number;
}

export class SshHelperClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly signingKey: ReturnType<typeof createPrivateKey> | null;
  private readonly now: () => number;

  constructor(
    private readonly baseUrl: string = config.ssh?.helperUrl ?? "",
    signingKeyFile: string = config.ssh?.signingPrivateKeyFile ?? "",
    options: SshHelperClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.signingKey = options.signingKey ?? loadSigningKey(signingKeyFile);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getPublicKey(): Promise<SshHelperPublicKey> {
    return this.request("public_key", "/public-key", "GET", null, isPublicKey);
  }

  async getStatus(): Promise<SshHelperStatus> {
    return this.request("status", "/status", "GET", null, isStatus);
  }

  async unlock(
    requestId: string,
    userId: number,
    expiresAt: number,
    envelope: SshUnlockEnvelope,
  ): Promise<SshHelperStatus> {
    return this.request(
      "unlock",
      "/unlock",
      "POST",
      { requestId, userId, expiresAt, envelope },
      isStatus,
    );
  }

  async lock(): Promise<SshHelperStatus> {
    return this.request("lock", "/lock", "POST", null, isStatus);
  }

  private async request<T>(
    operation: SignedRequestBody["operation"],
    requestPath: string,
    method: "GET" | "POST",
    body: unknown,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    if (!this.baseUrl || this.signingKey === null) {
      throw new SshHelperClientError("SSH helper is not configured");
    }

    const requestId = randomUUID();
    const expiresAt = this.now() + 30;
    const signedBody: SignedRequestBody = { operation, requestId, expiresAt, body };
    const canonical = JSON.stringify(signedBody);
    const signature = sign(null, Buffer.from(canonical), this.signingKey).toString("base64url");
    const requestSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        method,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        headers: {
          "X-SSH-Operation": operation,
          "X-SSH-Request-Id": requestId,
          "X-SSH-Expires-At": String(expiresAt),
          "X-SSH-Signature": signature,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        signal: requestSignal,
      });
    } catch {
      throw new SshHelperClientError("SSH helper is unavailable");
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SshHelperClientError("SSH helper rejected the request", response.status);
    }
    if (!validate(payload)) {
      throw new SshHelperClientError("SSH helper returned an invalid response");
    }
    return payload;
  }
}

function loadSigningKey(filePath: string): ReturnType<typeof createPrivateKey> | null {
  if (!filePath) {
    return null;
  }

  try {
    return createPrivateKey(fs.readFileSync(filePath));
  } catch {
    throw new Error(`SSH_HELPER_SIGNING_PRIVATE_KEY_FILE could not be loaded: ${filePath}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPublicKey(value: unknown): value is SshHelperPublicKey {
  return isRecord(value) && typeof value.keyId === "string" && typeof value.publicKey === "string";
}

function isStatus(value: unknown): value is SshHelperStatus {
  return (
    isRecord(value) &&
    (value.state === "locked" || value.state === "unlocked") &&
    typeof value.keyId === "string" &&
    (value.fingerprint === null || typeof value.fingerprint === "string")
  );
}
