import { describe, expect, it } from "vitest";
import { readLaunchSelection, selectFile } from "../../mini-app/src/selection.js";
import type { DiffFile } from "../../mini-app/src/types.js";

const files: DiffFile[] = [
  { path: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: "@@", reason: null },
  {
    path: "assets/logo.svg",
    status: "modified",
    additions: 0,
    deletions: 0,
    patch: null,
    reason: "Binary file",
  },
];

describe("mini app launch selection", () => {
  it("reads the session and encoded file from the launch URL", () => {
    expect(
      readLaunchSelection("https://example.test/mini-app/?session_id=s-1&file=src%2Fapp.ts"),
    ).toEqual({
      sessionId: "s-1",
      filePath: "src/app.ts",
      messageId: null,
      callId: null,
    });
  });

  it("uses the requested file exactly and reports a stale selection", () => {
    expect(selectFile(files, "src/app.ts", null)).toEqual({
      file: files[0],
      requestedFileMissing: false,
    });
    expect(selectFile(files, "src/missing.ts", null)).toEqual({
      file: null,
      requestedFileMissing: true,
    });
  });

  it("uses the server selection or first file when no file was requested", () => {
    expect(selectFile(files, null, "assets/logo.svg").file).toBe(files[1]);
    expect(selectFile(files, null, null).file).toBe(files[0]);
  });
});
