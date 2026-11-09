import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { wakeCommand } from "../../../src/bot/commands/wake-command.js";

function createContext(): Context {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function createStatus(healthy: boolean) {
  return {
    status: healthy ? "healthy" : "degraded",
    uptimeSeconds: 10,
    timestamp: "2026-11-09T00:00:00.000Z",
    target: { ip: "192.168.88.227", port: 4096, reachable: healthy },
    opencode: {
      reachable: healthy,
      healthy,
      authenticationRequired: false,
    },
    readiness: {
      checkedAt: "2026-11-09T00:00:00.000Z",
      latencyMs: 3,
      wakeInProgress: false,
    },
  } as const;
}

function createWakeResult(woke: boolean) {
  return {
    ready: true,
    woke,
    wakeDurationMs: 2_000,
    snapshot: {
      checkedAt: "2026-11-09T00:00:02.000Z",
      latencyMs: 3,
      targetReachable: true,
      openCodeReachable: true,
      healthy: true,
      authenticationRequired: false,
      version: "1.0.0",
      statusCode: 200,
    },
  } as const;
}

describe("wakeCommand", () => {
  it("reports the expected unreachable state before waking the target", async () => {
    const ctx = createContext();
    const getStatus = vi.fn().mockResolvedValue(createStatus(false));
    const wake = vi.fn().mockResolvedValue(createWakeResult(true));
    const gatewayClient = { isConfigured: () => true, getStatus, wake };

    await wakeCommand(ctx as never, { gatewayClient } as never);

    expect(ctx.reply).toHaveBeenNthCalledWith(
      1,
      "OpenCode is unreachable. Sending Wake-on-LAN...",
    );
    expect(wake).toHaveBeenCalledTimes(1);
    const statusCallOrder = getStatus.mock.invocationCallOrder[0];
    const wakeCallOrder = wake.mock.invocationCallOrder[0];
    expect(statusCallOrder).toBeDefined();
    expect(wakeCallOrder).toBeDefined();
    expect(statusCallOrder!).toBeLessThan(wakeCallOrder!);
  });

  it("does not report an unreachable state when OpenCode is already healthy", async () => {
    const ctx = createContext();
    const getStatus = vi.fn().mockResolvedValue(createStatus(true));
    const wake = vi.fn().mockResolvedValue(createWakeResult(false));
    const gatewayClient = { isConfigured: () => true, getStatus, wake };

    await wakeCommand(ctx as never, { gatewayClient } as never);

    expect(ctx.reply).not.toHaveBeenCalledWith("OpenCode is unreachable. Sending Wake-on-LAN...");
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
