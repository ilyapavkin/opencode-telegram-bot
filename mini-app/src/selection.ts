import type { DiffFile, LaunchSelection } from "./types.js";

export interface SelectedFile {
  file: DiffFile | null;
  requestedFileMissing: boolean;
}

export function readLaunchSelection(href: string): LaunchSelection {
  const url = new URL(href);
  return {
    sessionId: nonEmpty(url.searchParams.get("session_id")),
    filePath: nonEmpty(url.searchParams.get("file")),
    messageId: nonEmpty(url.searchParams.get("message_id")),
    callId: nonEmpty(url.searchParams.get("call_id")),
  };
}

export function selectFile(
  files: readonly DiffFile[],
  requestedFile: string | null,
  serverSelectedFile: string | null,
): SelectedFile {
  if (requestedFile !== null) {
    return {
      file: files.find((file) => file.path === requestedFile) ?? null,
      requestedFileMissing: files.every((file) => file.path !== requestedFile),
    };
  }

  if (serverSelectedFile !== null) {
    const selected = files.find((file) => file.path === serverSelectedFile);
    if (selected !== undefined) {
      return { file: selected, requestedFileMissing: false };
    }
  }

  return { file: files[0] ?? null, requestedFileMissing: false };
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}
