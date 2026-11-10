import { describe, expect, it, vi } from "vitest";
import {
  SshUnlockService,
  SshUnlockServiceError,
} from "../../../src/app/services/ssh-unlock-service.js";
import type { SshHelperPublicKey, SshHelperStatus } from "../../../src/app/types/ssh.js";

const publicKey: SshHelperPublicKey = { keyId: "key-1", publicKey: "public-key" };
const status: SshHelperStatus = { state: "locked", keyId: "key-1", fingerprint: null };

function fakeHelper() {
  return {
    getPublicKey: vi.fn(async () => publicKey),
    getStatus: vi.fn(async () => status),
    unlock: vi.fn(async () => ({
      state: "unlocked" as const,
      keyId: "key-1",
      fingerprint: "SHA256:test",
    })),
    lock: vi.fn(async () => status),
  };
}

describe("SSH unlock service", () => {
  it("binds authorization to the user, key, and one-time token", async () => {
    const helper = fakeHelper();
    const service = new SshUnlockService(helper);
    const authorization = await service.authorize(123);
    const envelope = {
      version: 1 as const,
      keyId: authorization.keyId,
      requestId: authorization.requestId,
      expiresAt: authorization.expiresAt,
      nonce: "AAAAAAAAAAAAAAAA",
      wrappedKey: "wrapped",
      ciphertext: "ciphertext",
    };

    await service.unlock(123, authorization.requestId, authorization.authorizationToken, envelope);
    await expect(
      service.unlock(123, authorization.requestId, authorization.authorizationToken, envelope),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(helper.unlock).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed key or envelope binding before contacting the helper", async () => {
    const helper = fakeHelper();
    const service = new SshUnlockService(helper);
    const authorization = await service.authorize(123);

    await expect(
      service.unlock(123, authorization.requestId, authorization.authorizationToken, {
        version: 1,
        keyId: "different-key",
        requestId: authorization.requestId,
        expiresAt: authorization.expiresAt,
        nonce: "AAAAAAAAAAAAAAAA",
        wrappedKey: "wrapped",
        ciphertext: "ciphertext",
      }),
    ).rejects.toBeInstanceOf(SshUnlockServiceError);
    expect(helper.unlock).not.toHaveBeenCalled();
  });
});
