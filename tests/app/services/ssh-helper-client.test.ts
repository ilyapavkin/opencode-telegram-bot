import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SshHelperClient } from "../../../src/app/services/ssh-helper-client.js";

describe("SSH helper client", () => {
  it("signs the exact helper request body without exposing secrets in headers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let received: RequestInit | undefined;
    const client = new SshHelperClient("https://helper.example", "", {
      signingKey: privateKey,
      now: () => 1_700_000_000,
      fetch: async (_input, init) => {
        received = init;
        return new Response(JSON.stringify({ keyId: "key-1", publicKey: "public-key" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await client.getPublicKey();

    expect(received?.method).toBe("GET");
    expect(received?.headers).toMatchObject({
      "X-SSH-Operation": "public_key",
      "X-SSH-Expires-At": "1700000030",
    });
    expect(received?.headers).not.toHaveProperty("passphrase");
    const signature = String((received?.headers as Record<string, string>)["X-SSH-Signature"]);
    expect(signature).not.toBe("undefined");
    expect(publicKey).toBeDefined();
  });
});
