export type DiffFileStatus =
  "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | string;

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  reason: string | null;
}

export interface DiffSession {
  id: string;
  title: string;
  project: string;
  branch: string | null;
}

export interface DiffResponse {
  session: DiffSession;
  files: DiffFile[];
  selectedFile: string | null;
}

export interface LaunchSelection {
  sessionId: string | null;
  filePath: string | null;
  messageId: string | null;
  callId: string | null;
}

export type ApiFailureKind = "unauthorized" | "unavailable" | "oversized";

export class ApiError extends Error {
  public readonly kind: ApiFailureKind;
  public readonly status: number | null;

  public constructor(kind: ApiFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export interface TelegramWebApp {
  initData: string;
  themeParams: Record<string, string | undefined>;
  ready: () => void;
  expand: () => void;
  onEvent: (event: string, callback: () => void) => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}
