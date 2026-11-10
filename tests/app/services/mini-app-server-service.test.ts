import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  validateInitData: vi.fn(),
  loadDiff: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    opencode: { serverVersion: "v1", apiUrl: "http://localhost:4096" },
    gateway: { apiUrl: "http://localhost:4096", sharedSecret: "" },
    miniApp: {
      enabled: true,
      url: "https://example.test/mini-app",
      bindHost: "127.0.0.1",
      port: 0,
      initDataMaxAgeSec: 3600,
      maxDiffBytes: 100,
    },
    telegram: { token: "token", allowedUserId: 123 },
  },
}));
vi.mock("../../../src/app/services/mini-app-auth-service.js", () => ({
  MiniAppAuthError: class MiniAppAuthError extends Error {},
  validateMiniAppInitData: mocked.validateInitData,
}));
vi.mock("../../../src/app/services/mini-app-diff-service.js", () => ({
  MiniAppDiffError: class MiniAppDiffError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  },
  loadMiniAppDiff: mocked.loadDiff,
}));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      get: vi.fn(),
      diff: vi.fn(),
    },
  },
}));

const { MiniAppServer } = await import("../../../src/app/services/mini-app-server-service.js");

describe("mini-app server", () => {
  let server: InstanceType<typeof MiniAppServer>;
  let staticRoot: string;

  beforeEach(async () => {
    staticRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-app-server-"));
    await fs.mkdir(path.join(staticRoot, "assets"));
    await fs.writeFile(path.join(staticRoot, "index.html"), "<html>mini app</html>");
    await fs.writeFile(path.join(staticRoot, "assets", "main.js"), "console.log('ok');");
    mocked.validateInitData.mockReset();
    mocked.validateInitData.mockReturnValue({ userId: 123 });
    mocked.loadDiff.mockReset();
    mocked.loadDiff.mockResolvedValue({
      session: { id: "ses-1", title: "Session", project: "repo", branch: "main" },
      files: [],
      selectedFile: null,
    });
    server = new MiniAppServer(staticRoot);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(staticRoot, { recursive: true, force: true });
  });

  it("serves the Mini App shell and assets", async () => {
    await expect(fetchAt("/mini-app/")).resolves.toMatchObject({
      status: 200,
      body: "<html>mini app</html>",
    });
    await expect(fetchAt("/mini-app/assets/main.js")).resolves.toMatchObject({
      status: 200,
      body: "console.log('ok');",
    });
  });

  it("requires Telegram authentication for the diff API", async () => {
    await expect(fetchAt("/mini-app/api/diff?session_id=ses-1")).resolves.toMatchObject({
      status: 401,
    });
    expect(mocked.loadDiff).not.toHaveBeenCalled();
  });

  it("loads a diff using the authenticated initData header", async () => {
    const result = await fetchAt("/mini-app/api/diff?session_id=ses-1&file=src%2Fa.ts", {
      "X-Telegram-Init-Data": "auth-date=data",
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ selectedFile: null });
    expect(mocked.validateInitData).toHaveBeenCalledWith("auth-date=data", "token", 123, 3600);
    expect(mocked.loadDiff).toHaveBeenCalledWith("ses-1", "src/a.ts");
  });

  async function fetchAt(
    requestPath: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    const internal = server as unknown as { server: http.Server | null };
    const address = internal.server?.address();
    if (address === null || typeof address === "string" || address === undefined) {
      throw new Error("Mini App server has no TCP address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${requestPath}`, { headers });
    return { status: response.status, body: await response.text() };
  }
});
