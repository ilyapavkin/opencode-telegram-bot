import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import { createRequestHandler } from "../src/http-server.js";
import type { AgentController } from "../src/agent.js";
import type { EncryptionKeys } from "../src/crypto.js";
import type { HelperConfig, SignedRequest } from "../src/types.js";

test("requires a valid signed request and rejects replay", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys: EncryptionKeys = { privateKey, publicKey: "public-key", keyId: "key-1" };
  const agent: AgentController = {
    status: async () => "locked",
    fingerprint: async () => null,
    unlock: async () => "SHA256:test",
    lock: async () => {},
  };
  const config: HelperConfig = {
    bindHost: "127.0.0.1",
    port: 0,
    sshKeyPath: "/tmp/key",
    agentSocket: "/tmp/agent.sock",
    encryptionKeyFile: "/tmp/encryption.pem",
    botSigningPublicKeyFile: "/tmp/signing.pub",
    allowedTraefikAddress: "127.0.0.1",
  };
  const server = http.createServer(createRequestHandler(config, keys, publicKey, agent));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address!.port}/status`;

  const request = signedRequest(privateKey, "status", "request-1", null);
  const headers = {
    "X-SSH-Operation": request.operation,
    "X-SSH-Request-Id": request.requestId,
    "X-SSH-Expires-At": String(request.expiresAt),
    "X-SSH-Signature": request.signature,
  };
  const first = await fetch(endpoint, { headers });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { state: "locked", keyId: "key-1", fingerprint: null });

  const replay = await fetch(endpoint, { headers });
  assert.equal(replay.status, 409);

  const invalid = await fetch(endpoint, { headers: { ...headers, "X-SSH-Signature": "bad" } });
  assert.equal(invalid.status, 401);
});

function signedRequest(
  privateKey: KeyObject,
  operation: SignedRequest["operation"],
  requestId: string,
  body: unknown,
): SignedRequest & { signature: string } {
  const request = { operation, requestId, expiresAt: Math.floor(Date.now() / 1000) + 30, body };
  return {
    ...request,
    signature: sign(null, Buffer.from(JSON.stringify(request)), privateKey).toString("base64url"),
  };
}
