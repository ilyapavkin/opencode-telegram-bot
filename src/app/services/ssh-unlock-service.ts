import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import type {
  SshHelperPublicKey,
  SshHelperStatus,
  SshUnlockAuthorization,
  SshUnlockEnvelope,
} from "../types/ssh.js";
import { SshHelperClient, SshHelperClientError } from "./ssh-helper-client.js";

export interface SshHelperClientLike {
  getPublicKey(): Promise<SshHelperPublicKey>;
  getStatus(): Promise<SshHelperStatus>;
  unlock(
    requestId: string,
    userId: number,
    expiresAt: number,
    envelope: SshUnlockEnvelope,
  ): Promise<SshHelperStatus>;
  lock(): Promise<SshHelperStatus>;
}

interface PendingRequest {
  userId: number;
  tokenHash: Buffer;
  keyId: string;
  expiresAt: number;
  used: boolean;
}

export class SshUnlockServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code:
      | "unavailable"
      | "invalid_request"
      | "rate_limited"
      | "unauthorized"
      | "unlock_failed" = "unavailable",
  ) {
    super(message);
    this.name = "SshUnlockServiceError";
  }
}

export class SshUnlockService {
  private readonly pending = new Map<string, PendingRequest>();
  private failedAttempts = { count: 0, resetAt: 0 };

  constructor(private readonly helper: SshHelperClientLike = new SshHelperClient()) {}

  async publicKey(): Promise<SshHelperPublicKey> {
    return this.callHelper(() => this.helper.getPublicKey());
  }

  async status(): Promise<SshHelperStatus> {
    return this.callHelper(() => this.helper.getStatus());
  }

  async authorize(userId: number): Promise<SshUnlockAuthorization> {
    this.prune();
    const publicKey = await this.publicKey();
    const now = Math.floor(Date.now() / 1000);
    const requestId = randomBytes(18).toString("base64url");
    const authorizationToken = randomBytes(32).toString("base64url");
    const expiresAt = now + config.ssh.unlockRequestTtlSec;

    this.pending.set(requestId, {
      userId,
      tokenHash: hashToken(authorizationToken),
      keyId: publicKey.keyId,
      expiresAt,
      used: false,
    });

    return {
      requestId,
      authorizationToken,
      keyId: publicKey.keyId,
      publicKey: publicKey.publicKey,
      expiresAt,
    };
  }

  async unlock(
    userId: number,
    requestId: string,
    authorizationToken: string,
    envelope: SshUnlockEnvelope,
  ): Promise<SshHelperStatus> {
    this.prune();
    const request = this.pending.get(requestId);
    if (!request || request.userId !== userId || request.used || request.expiresAt < now()) {
      throw new SshUnlockServiceError(
        "Unlock authorization is invalid or expired",
        401,
        "unauthorized",
      );
    }
    if (!safeTokenEquals(request.tokenHash, hashToken(authorizationToken))) {
      throw new SshUnlockServiceError(
        "Unlock authorization is invalid or expired",
        401,
        "unauthorized",
      );
    }
    if (this.failedAttempts.resetAt <= now()) {
      this.failedAttempts = { count: 0, resetAt: now() + config.ssh.unlockRequestTtlSec };
    }
    if (this.failedAttempts.count >= config.ssh.maxAttempts) {
      throw new SshUnlockServiceError("Too many failed unlock attempts", 429, "rate_limited");
    }
    validateEnvelope(envelope, requestId, request.keyId, request.expiresAt);
    request.used = true;

    try {
      const status = await this.helper.unlock(requestId, userId, request.expiresAt, envelope);
      this.failedAttempts = { count: 0, resetAt: 0 };
      return status;
    } catch (error) {
      this.failedAttempts.count += 1;
      if (error instanceof SshHelperClientError && error.statusCode === 401) {
        throw new SshUnlockServiceError("SSH key unlock failed", 401, "unlock_failed");
      }
      if (error instanceof SshHelperClientError) {
        throw new SshUnlockServiceError("SSH helper is unavailable", 503);
      }
      throw error;
    }
  }

  async lock(): Promise<SshHelperStatus> {
    return this.callHelper(() => this.helper.lock());
  }

  private async callHelper<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SshUnlockServiceError) {
        throw error;
      }
      throw new SshUnlockServiceError("SSH helper is unavailable", 503);
    }
  }

  private prune(): void {
    const currentTime = now();
    for (const [requestId, request] of this.pending) {
      if (request.used || request.expiresAt < currentTime) {
        this.pending.delete(requestId);
      }
    }
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function safeTokenEquals(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateEnvelope(
  envelope: SshUnlockEnvelope,
  requestId: string,
  keyId: string,
  expiresAt: number,
): void {
  if (
    envelope.version !== 1 ||
    envelope.keyId !== keyId ||
    envelope.requestId !== requestId ||
    envelope.expiresAt !== expiresAt ||
    !isEncoded(envelope.nonce, 12) ||
    !isEncoded(envelope.wrappedKey) ||
    !isEncoded(envelope.ciphertext)
  ) {
    throw new SshUnlockServiceError("Invalid unlock envelope", 400, "invalid_request");
  }
}

function isEncoded(value: string, exactBytes?: number): boolean {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  if (exactBytes === undefined) {
    return true;
  }
  return Math.ceil((value.length * 6) / 8) === exactBytes;
}
