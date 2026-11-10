import path from "node:path";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { getPatchFileChanges } from "../formatters/summary-formatter.js";
import { getCurrentProject } from "../stores/settings-store.js";
import { getCurrentSession } from "./session-service.js";
import { getGitWorktreeContext } from "./worktree-service.js";

const MAX_FILE_COUNT = 200;
const MAX_SELECTOR_LENGTH = 1024;
const MAX_ID_LENGTH = 256;

export interface MiniAppDiffFile {
  path: string;
  status: "added" | "deleted" | "modified" | string;
  additions: number;
  deletions: number;
  patch: string | null;
  reason: string | null;
}

export interface MiniAppDiffResponse {
  session: {
    id: string;
    title: string;
    project: string;
    branch: string | null;
  };
  files: MiniAppDiffFile[];
  selectedFile: string | null;
}

export type MiniAppDiffErrorCode = "unavailable" | "invalid_selector" | "oversized";

export class MiniAppDiffError extends Error {
  constructor(
    readonly code: MiniAppDiffErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "MiniAppDiffError";
  }
}

type SessionDiff = NonNullable<Awaited<ReturnType<typeof opencodeClient.session.diff>>["data"]>;
type SessionMessages = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.session.messages>>["data"]
>;

export async function loadMiniAppDiff(
  sessionId: string,
  requestedFile: string | null,
): Promise<MiniAppDiffResponse> {
  const selectedPath = requestedFile === null ? null : normalizeSelector(requestedFile);
  const { currentSession, currentProject, session } = await verifySessionAccess(sessionId);

  let diff: SessionDiff | undefined;
  let diffError: unknown;
  try {
    ({ data: diff, error: diffError } = await opencodeClient.session.diff({
      sessionID: sessionId,
      directory: currentSession.directory,
    }));
  } catch {
    throw unavailable("The session diff is no longer available");
  }
  if (diffError || !diff) {
    throw unavailable("The session diff is no longer available");
  }

  const files = normalizeDiff(diff, currentSession.directory);
  if (files.length > MAX_FILE_COUNT) {
    throw new MiniAppDiffError("oversized", "This session contains too many changed files", 413);
  }

  const patchBytes = files.reduce(
    (total, file) => total + (file.patch === null ? 0 : Buffer.byteLength(file.patch)),
    0,
  );
  if (patchBytes > config.miniApp.maxDiffBytes) {
    throw new MiniAppDiffError("oversized", "This session diff is too large to display", 413);
  }

  if (selectedPath !== null && !files.some((file) => file.path === selectedPath)) {
    throw unavailable("The requested file is no longer available");
  }

  let branch: string | null = null;
  try {
    branch = (await getGitWorktreeContext(currentProject.worktree))?.branch ?? null;
  } catch {
    branch = null;
  }

  return {
    session: buildSessionSummary(
      session,
      currentSession.title,
      currentProject.name,
      currentProject.worktree,
      branch,
    ),
    files,
    selectedFile: selectedPath,
  };
}

export async function loadMiniAppChange(
  sessionId: string,
  messageId: string,
  callId: string,
  requestedFile: string | null,
): Promise<MiniAppDiffResponse> {
  const selectedPath = requestedFile === null ? null : normalizeSelector(requestedFile);
  const normalizedMessageId = normalizeId(messageId, "message_id");
  const normalizedCallId = normalizeId(callId, "call_id");
  const { currentSession, currentProject, session } = await verifySessionAccess(sessionId);

  let messages: SessionMessages | undefined;
  let messagesError: unknown;
  try {
    ({ data: messages, error: messagesError } = await opencodeClient.session.messages({
      sessionID: sessionId,
      directory: currentSession.directory,
    }));
  } catch {
    throw unavailable("The requested change is no longer available");
  }
  if (messagesError || !messages) {
    throw unavailable("The requested change is no longer available");
  }

  const toolPart = findToolPart(messages, normalizedMessageId, normalizedCallId);
  if (!toolPart) {
    throw unavailable("The requested change is no longer available");
  }

  const files = normalizeToolFiles(toolPart, currentSession.directory);
  if (files.length > MAX_FILE_COUNT) {
    throw new MiniAppDiffError("oversized", "This change contains too many files", 413);
  }

  const patchBytes = files.reduce(
    (total, file) => total + (file.patch === null ? 0 : Buffer.byteLength(file.patch)),
    0,
  );
  if (patchBytes > config.miniApp.maxDiffBytes) {
    throw new MiniAppDiffError("oversized", "This change is too large to display", 413);
  }

  if (selectedPath !== null && !files.some((file) => file.path === selectedPath)) {
    throw unavailable("The requested file is no longer available");
  }

  let branch: string | null = null;
  try {
    branch = (await getGitWorktreeContext(currentProject.worktree))?.branch ?? null;
  } catch {
    branch = null;
  }

  return {
    session: buildSessionSummary(
      session,
      currentSession.title,
      currentProject.name,
      currentProject.worktree,
      branch,
    ),
    files,
    selectedFile: selectedPath,
  };
}

async function verifySessionAccess(sessionId: string): Promise<{
  currentSession: NonNullable<ReturnType<typeof getCurrentSession>>;
  currentProject: NonNullable<ReturnType<typeof getCurrentProject>>;
  session: NonNullable<Awaited<ReturnType<typeof opencodeClient.session.get>>["data"]>;
}> {
  const currentSession = getCurrentSession();
  const currentProject = getCurrentProject();

  if (!currentSession || !currentProject || currentSession.id !== sessionId) {
    throw unavailable("The requested session is no longer available");
  }

  if (!samePath(currentSession.directory, currentProject.worktree)) {
    throw unavailable("The current session project is no longer available");
  }

  let session: Awaited<ReturnType<typeof opencodeClient.session.get>>["data"];
  let sessionError: unknown;
  try {
    ({ data: session, error: sessionError } = await opencodeClient.session.get({
      sessionID: sessionId,
      directory: currentSession.directory,
    }));
  } catch {
    throw unavailable("The requested session is no longer available");
  }
  if (sessionError || !session || !samePath(session.directory, currentSession.directory)) {
    throw unavailable("The requested session is no longer available");
  }

  return { currentSession, currentProject, session };
}

function buildSessionSummary(
  session: { id: string; title: string },
  fallbackTitle: string,
  project: string | undefined,
  worktree: string,
  branch: string | null,
): MiniAppDiffResponse["session"] {
  return {
    id: session.id,
    title: session.title || fallbackTitle || "new session",
    project: project || projectName(worktree),
    branch,
  };
}

function normalizeId(value: string, name: string): string {
  if (value.length === 0 || value.length > MAX_ID_LENGTH || value.includes("\0")) {
    throw new MiniAppDiffError("invalid_selector", `The requested ${name} is invalid`, 400);
  }
  return value;
}

function findToolPart(messages: SessionMessages, messageId: string, callId: string) {
  for (const message of messages) {
    if (message.info.id !== messageId) {
      continue;
    }
    const part = message.parts.find(
      (candidate) => candidate.type === "tool" && candidate.callID === callId,
    );
    if (part?.type === "tool") {
      return part;
    }
  }
  return null;
}

function normalizeToolFiles(
  toolPart: Extract<SessionMessages[number]["parts"][number], { type: "tool" }>,
  directory: string,
): MiniAppDiffFile[] {
  const files: MiniAppDiffFile[] = [];
  const input = toolPart.state.input;
  const metadata = "metadata" in toolPart.state ? toolPart.state.metadata : undefined;

  if (toolPart.tool === "write") {
    const filePath = typeof input.filePath === "string" ? input.filePath : "";
    const content = typeof input.content === "string" ? input.content : null;
    if (filePath && content !== null) {
      const path = normalizeServerPath(filePath, directory);
      if (path) {
        files.push({
          path,
          status: "modified",
          additions: content.split("\n").length,
          deletions: 0,
          patch: buildWritePatch(content),
          reason: null,
        });
      }
    }
  } else if (toolPart.tool === "edit") {
    const filediff = isRecord(metadata?.filediff) ? metadata.filediff : undefined;
    const path =
      typeof filediff?.file === "string" ? normalizeServerPath(filediff.file, directory) : null;
    const patch = typeof metadata?.diff === "string" ? metadata.diff : null;
    if (path) {
      files.push({
        path,
        status: "modified",
        additions: nonNegativeInteger(filediff?.additions),
        deletions: nonNegativeInteger(filediff?.deletions),
        patch,
        reason: patch === null ? "Patch content is unavailable for this change" : null,
      });
    }
  } else if (toolPart.tool === "apply_patch") {
    const changes = getPatchFileChanges(metadata);
    for (const change of changes) {
      const path = normalizeServerPath(change.path, directory);
      if (!path) {
        continue;
      }
      files.push({
        path,
        status: "modified",
        additions: change.additions,
        deletions: change.deletions,
        patch: change.diff || null,
        reason: change.diff ? null : "Patch content is unavailable for this change",
      });
    }
  }

  return deduplicateFiles(files);
}

function deduplicateFiles(files: MiniAppDiffFile[]): MiniAppDiffFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    return true;
  });
}

function buildWritePatch(content: string): string {
  const lines = content.split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeDiff(diff: SessionDiff, directory: string): MiniAppDiffFile[] {
  const files: MiniAppDiffFile[] = [];
  const seen = new Set<string>();

  for (const entry of diff) {
    const raw = entry as unknown as {
      file?: unknown;
      patch?: unknown;
      status?: unknown;
      additions?: unknown;
      deletions?: unknown;
    };
    if (typeof raw.file !== "string") {
      continue;
    }

    const filePath = normalizeServerPath(raw.file, directory);
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);

    const patch = typeof raw.patch === "string" ? raw.patch : null;
    files.push({
      path: filePath,
      status:
        raw.status === "added" || raw.status === "deleted" || raw.status === "modified"
          ? raw.status
          : "modified",
      additions: nonNegativeInteger(raw.additions),
      deletions: nonNegativeInteger(raw.deletions),
      patch,
      reason: patch === null ? "Patch content is unavailable for this file" : null,
    });
  }

  return files;
}

function normalizeSelector(value: string): string {
  if (value.length === 0 || value.length > MAX_SELECTOR_LENGTH || value.includes("\0")) {
    throw new MiniAppDiffError("invalid_selector", "The requested file selector is invalid", 400);
  }

  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new MiniAppDiffError("invalid_selector", "The requested file selector is invalid", 400);
  }

  return normalized;
}

function normalizeServerPath(file: string, directory: string): string | null {
  const normalizedFile = file.replace(/\\/g, "/");
  const isWindowsPath = /^[a-zA-Z]:\//.test(normalizedFile) || normalizedFile.startsWith("//");
  const pathModule = isWindowsPath ? path.win32 : path.posix;
  const relative = pathModule.isAbsolute(normalizedFile)
    ? pathModule.relative(pathModule.resolve(directory), pathModule.resolve(normalizedFile))
    : normalizedFile;
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");

  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    return null;
  }

  return normalized;
}

function samePath(left: string, right: string): boolean {
  const windowsPath =
    process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(left) || /^[a-zA-Z]:[\\/]/.test(right);
  const pathModule = windowsPath ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const normalized = pathModule.normalize(value);
    const root = pathModule.parse(normalized).root;
    return normalized === root ? normalized : normalized.replace(/[\\/]$/, "");
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return windowsPath
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function projectName(worktree: string): string {
  return worktree.split(/[\\/]/).filter(Boolean).at(-1) || worktree;
}

function unavailable(message: string): MiniAppDiffError {
  return new MiniAppDiffError("unavailable", message, 404);
}
