import { ApiError } from "./types.js";
import type { DiffFile, DiffResponse, LaunchSelection } from "./types.js";

const DIFF_API_PATH = "/mini-app/api/diff";
const CHANGE_API_PATH = "/mini-app/api/change";

export async function fetchDiff(selection: LaunchSelection): Promise<DiffResponse> {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  if (initData === "") {
    throw new ApiError("unauthorized", "Open this viewer from Telegram to authenticate.");
  }
  if (selection.sessionId === null) {
    throw new ApiError("unavailable", "This link does not contain a session.");
  }
  if ((selection.messageId === null) !== (selection.callId === null)) {
    throw new ApiError("unavailable", "This link does not contain a complete change selector.");
  }

  const params = new URLSearchParams({ session_id: selection.sessionId });
  if (selection.filePath !== null) params.set("file", selection.filePath);
  if (selection.messageId !== null) params.set("message_id", selection.messageId);
  if (selection.callId !== null) params.set("call_id", selection.callId);
  let response: Response;
  try {
    response = await fetch(
      `${selection.messageId === null ? DIFF_API_PATH : CHANGE_API_PATH}?${params.toString()}`,
      {
        headers: { "X-Telegram-Init-Data": initData },
      },
    );
  } catch {
    throw new ApiError("unavailable", "The diff service could not be reached.");
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw new ApiError(
      classifyFailure(response.status, payload),
      failureMessage(response.status, payload),
      response.status,
    );
  }

  return normalizeResponse(payload);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeResponse(payload: unknown): DiffResponse {
  if (!isRecord(payload) || !isRecord(payload.session) || !Array.isArray(payload.files)) {
    throw new ApiError("unavailable", "The diff service returned an invalid response.");
  }

  const session = payload.session;
  if (!isString(session.id) || !isString(session.title) || !isString(session.project)) {
    throw new ApiError("unavailable", "The diff service returned an invalid session.");
  }

  const files: DiffFile[] = [];
  for (const value of payload.files) {
    if (!isRecord(value) || !isString(value.path) || !isString(value.status)) {
      throw new ApiError("unavailable", "The diff service returned an invalid file.");
    }
    files.push({
      path: value.path,
      status: value.status,
      additions: numberOrZero(value.additions),
      deletions: numberOrZero(value.deletions),
      patch:
        value.patch === null || value.patch === undefined
          ? null
          : isString(value.patch)
            ? value.patch
            : null,
      reason:
        value.reason === null || value.reason === undefined
          ? null
          : isString(value.reason)
            ? value.reason
            : null,
    });
  }

  return {
    session: {
      id: session.id,
      title: session.title,
      project: session.project,
      branch:
        session.branch === null || session.branch === undefined
          ? null
          : isString(session.branch)
            ? session.branch
            : null,
    },
    files,
    selectedFile:
      payload.selectedFile === null || payload.selectedFile === undefined
        ? null
        : isString(payload.selectedFile)
          ? payload.selectedFile
          : null,
  };
}

function classifyFailure(
  status: number,
  payload: unknown,
): "unauthorized" | "unavailable" | "oversized" {
  const code = isRecord(payload) && isString(payload.code) ? payload.code : "";
  if (status === 401 || status === 403 || code === "unauthorized") return "unauthorized";
  if (status === 413 || code === "oversized") return "oversized";
  return "unavailable";
}

function failureMessage(status: number, payload: unknown): string {
  if (isRecord(payload) && isString(payload.message)) return payload.message;
  if (status === 401 || status === 403) return "Telegram authentication was rejected.";
  if (status === 413) return "This diff is too large to display.";
  if (status === 404) return "The session or file is no longer available.";
  return "The diff service is unavailable right now.";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
