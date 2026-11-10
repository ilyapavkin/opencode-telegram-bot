import { describe, expect, it, vi } from "vitest";

const getCurrentProject = vi.hoisted(() => vi.fn());

vi.mock("../../../src/config.js", () => ({
  config: {
    opencode: { serverVersion: "v1", apiUrl: "http://localhost:4096" },
    gateway: { apiUrl: "http://localhost:4096", sharedSecret: "" },
    miniApp: {
      enabled: true,
      url: "https://bot.example/mini-app",
    },
  },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject,
}));

const { buildMiniAppKeyboard } = await import("../../../src/bot/pinned/mini-app-keyboard.js");

describe("pinned Mini App keyboard", () => {
  it("creates file buttons for displayed files and an all-diffs button", () => {
    getCurrentProject.mockReturnValue({ worktree: "/repo" });

    const keyboard = buildMiniAppKeyboard("ses-1", [
      { file: "/repo/src/example.ts", additions: 2, deletions: 1 },
      { file: "src/relative.ts", additions: 1, deletions: 0 },
    ]);

    expect(keyboard?.inline_keyboard).toHaveLength(3);
    expect(keyboard?.inline_keyboard[0]?.[0]).toMatchObject({
      web_app: {
        url: "https://bot.example/mini-app/?session_id=ses-1&file=src%2Fexample.ts",
      },
    });
    expect(keyboard?.inline_keyboard.at(-1)?.[0]).toMatchObject({
      web_app: {
        url: "https://bot.example/mini-app/?session_id=ses-1",
      },
    });
  });

  it("limits file buttons to the dashboard's displayed rows", () => {
    getCurrentProject.mockReturnValue({ worktree: "/repo" });
    const files = Array.from({ length: 12 }, (_, index) => ({
      file: `/repo/file-${index}.ts`,
      additions: 1,
      deletions: 0,
    }));

    const keyboard = buildMiniAppKeyboard("ses-1", files);

    expect(keyboard?.inline_keyboard).toHaveLength(11);
  });
});
