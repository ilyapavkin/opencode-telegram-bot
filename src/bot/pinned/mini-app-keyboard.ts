import { InlineKeyboard } from "grammy";
import { config } from "../../config.js";
import { getPatchFileChanges } from "../../app/formatters/summary-formatter.js";
import type { ToolInfo } from "../../app/managers/summary-aggregation-manager.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import type { FileChange } from "./pinned-message-types.js";
import { t } from "../../i18n/index.js";

const MAX_DISPLAYED_FILES = 10;

export function buildMiniAppKeyboard(
  sessionId: string | null,
  files: FileChange[],
): InlineKeyboard | undefined {
  const canOpenDiff = config.miniApp.enabled && config.miniApp.url && sessionId;
  const canOpenSsh = config.ssh?.enabled && config.ssh.miniAppUrl;
  if (!canOpenDiff && !canOpenSsh) {
    return undefined;
  }

  const keyboard = new InlineKeyboard();
  if (canOpenDiff && sessionId) {
    for (const file of files.slice(0, MAX_DISPLAYED_FILES)) {
      const selector = toFileSelector(file.file);
      if (!selector) {
        continue;
      }

      keyboard.webApp(
        t("pinned.files.open", { path: shortenLabel(selector) }),
        buildMiniAppUrl(sessionId, selector),
      );
      keyboard.row();
    }

    keyboard.webApp(t("pinned.files.open_all"), buildMiniAppUrl(sessionId));
  }

  if (canOpenSsh) {
    if (keyboard.inline_keyboard.length > 0) keyboard.row();
    keyboard.webApp(t("pinned.ssh.open"), config.ssh.miniAppUrl);
  }
  return keyboard;
}

export function buildMiniAppUrl(sessionId: string, file?: string): string {
  return buildMiniAppUrlWithChange(sessionId, file);
}

export function buildMiniAppChangeKeyboard(
  toolInfo: ToolInfo,
  requestedFiles?: readonly string[],
): InlineKeyboard | undefined {
  if (!config.miniApp.enabled || !config.miniApp.url) {
    return undefined;
  }

  const files = requestedFiles ?? getToolFilePaths(toolInfo);
  const selectors = files
    .slice(0, MAX_DISPLAYED_FILES)
    .map(toFileSelector)
    .filter((selector): selector is string => selector !== null);
  const keyboard = new InlineKeyboard();
  for (const [index, selector] of selectors.entries()) {
    keyboard.webApp(
      t("pinned.files.open", { path: shortenLabel(selector) }),
      buildMiniAppUrlWithChange(toolInfo.sessionId, selector, toolInfo.messageId, toolInfo.callId),
    );
    if (index < selectors.length - 1) {
      keyboard.row();
    }
  }

  return keyboard.inline_keyboard.some((row) => row.length > 0) ? keyboard : undefined;
}

function buildMiniAppUrlWithChange(
  sessionId: string,
  file?: string,
  messageId?: string,
  callId?: string,
): string {
  const url = new URL(`${config.miniApp.url}/`);
  url.searchParams.set("session_id", sessionId);
  if (file) {
    url.searchParams.set("file", file);
  }
  if (messageId && callId) {
    url.searchParams.set("message_id", messageId);
    url.searchParams.set("call_id", callId);
  }
  return url.toString();
}

function getToolFilePaths(toolInfo: ToolInfo): string[] {
  if (toolInfo.tool === "write") {
    return typeof toolInfo.input?.filePath === "string" ? [toolInfo.input.filePath] : [];
  }

  if (toolInfo.tool === "edit") {
    const filediff = isRecord(toolInfo.metadata?.filediff) ? toolInfo.metadata.filediff : undefined;
    return typeof filediff?.file === "string" ? [filediff.file] : [];
  }

  if (toolInfo.tool === "apply_patch") {
    return getPatchFileChanges(toolInfo.metadata).map((change) => change.path);
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFileSelector(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const project = getCurrentProject();
  const projectPath = project?.worktree.replace(/\\/g, "/");
  let selector = normalized;

  if (projectPath && selector.startsWith(`${projectPath}/`)) {
    selector = selector.slice(projectPath.length + 1);
  }

  selector = selector.replace(/^\.\//, "");
  if (
    !selector ||
    selector.startsWith("/") ||
    /^[a-zA-Z]:\//.test(selector) ||
    selector.split("/").some((part) => part === ".." || part === "")
  ) {
    return null;
  }

  return selector;
}

function shortenLabel(value: string): string {
  return value.length <= 48 ? value : `...${value.slice(-45)}`;
}
