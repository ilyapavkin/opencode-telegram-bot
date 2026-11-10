import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  currentSession: vi.fn(),
  currentProject: vi.fn(),
  sessionGet: vi.fn(),
  sessionDiff: vi.fn(),
  gitContext: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    miniApp: { maxDiffBytes: 100 },
  },
}));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      get: mocked.sessionGet,
      diff: mocked.sessionDiff,
    },
  },
}));
vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: mocked.currentSession,
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.currentProject,
}));
vi.mock("../../../src/app/services/worktree-service.js", () => ({
  getGitWorktreeContext: mocked.gitContext,
}));

const { MiniAppDiffError, loadMiniAppDiff } =
  await import("../../../src/app/services/mini-app-diff-service.js");

describe("mini-app diff service", () => {
  beforeEach(() => {
    mocked.currentSession.mockReturnValue({
      id: "ses-1",
      title: "Remembered title",
      directory: "D:/repo",
    });
    mocked.currentProject.mockReturnValue({ id: "project-1", name: "repo", worktree: "D:/repo" });
    mocked.sessionGet.mockResolvedValue({
      data: { id: "ses-1", title: "OpenCode title", directory: "D:/repo" },
    });
    mocked.sessionDiff.mockResolvedValue({
      data: [
        {
          file: "D:/repo/src/example.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
        },
        {
          file: "src/binary.png",
          status: "modified",
          additions: 0,
          deletions: 0,
        },
      ],
    });
    mocked.gitContext.mockResolvedValue({ branch: "main" });
  });

  it("normalizes server paths and keeps files without patch content", async () => {
    await expect(loadMiniAppDiff("ses-1", "src/example.ts")).resolves.toEqual({
      session: {
        id: "ses-1",
        title: "OpenCode title",
        project: "repo",
        branch: "main",
      },
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          reason: null,
        },
        {
          path: "src/binary.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          patch: null,
          reason: "Patch content is unavailable for this file",
        },
      ],
      selectedFile: "src/example.ts",
    });
  });

  it("rejects a session other than the pinned session", async () => {
    await expect(loadMiniAppDiff("ses-other", null)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocked.sessionGet).not.toHaveBeenCalled();
  });

  it("rejects unsafe file selectors", async () => {
    await expect(loadMiniAppDiff("ses-1", "../secret.txt")).rejects.toBeInstanceOf(
      MiniAppDiffError,
    );
    expect(mocked.sessionGet).not.toHaveBeenCalled();
  });

  it("rejects a selector that is not in the current diff", async () => {
    await expect(loadMiniAppDiff("ses-1", "src/missing.ts")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("rejects oversized patch responses", async () => {
    mocked.sessionDiff.mockResolvedValue({
      data: [{ file: "src/large.ts", patch: "x".repeat(101), additions: 1, deletions: 0 }],
    });

    await expect(loadMiniAppDiff("ses-1", null)).rejects.toMatchObject({
      code: "oversized",
      statusCode: 413,
    });
  });
});
