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

const { buildMiniAppChangeKeyboard, buildMiniAppKeyboard } =
  await import("../../../src/bot/pinned/mini-app-keyboard.js");

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

  it("creates exact change buttons with persisted tool selectors", () => {
    getCurrentProject.mockReturnValue({ worktree: "/repo" });

    const keyboard = buildMiniAppChangeKeyboard({
      sessionId: "ses-1",
      messageId: "msg-1",
      callId: "call-1",
      tool: "edit",
      input: {},
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "",
        metadata: {},
        time: { start: 0, end: 0 },
      },
      metadata: { filediff: { file: "/repo/src/example.ts" } },
    });

    expect(keyboard?.inline_keyboard[0]?.[0]).toMatchObject({
      web_app: {
        url: "https://bot.example/mini-app/?session_id=ses-1&file=src%2Fexample.ts&message_id=msg-1&call_id=call-1",
      },
    });
  });

  it("can restrict an exact keyboard to the document being sent", () => {
    getCurrentProject.mockReturnValue({ worktree: "/repo" });

    const keyboard = buildMiniAppChangeKeyboard(
      {
        sessionId: "ses-1",
        messageId: "msg-1",
        callId: "call-1",
        tool: "edit",
        input: {},
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: {},
          time: { start: 0, end: 0 },
        },
        metadata: { filediff: { file: "/repo/src/one.ts" } },
      },
      ["/repo/src/two.ts"],
    );

    const rows = keyboard?.inline_keyboard.filter((row) => row.length > 0) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toMatchObject({
      web_app: { url: expect.stringContaining("file=src%2Ftwo.ts") },
    });
  });
});
