import { InlineKeyboard } from "grammy";
import { config } from "../../config.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import type { FileChange } from "./pinned-message-types.js";
import { t } from "../../i18n/index.js";

const MAX_DISPLAYED_FILES = 10;

export function buildMiniAppKeyboard(
  sessionId: string | null,
  files: FileChange[],
): InlineKeyboard | undefined {
  if (!config.miniApp.enabled || !config.miniApp.url || !sessionId) {
    return undefined;
  }

  const keyboard = new InlineKeyboard();
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
  return keyboard;
}

export function buildMiniAppUrl(sessionId: string, file?: string): string {
  const url = new URL(`${config.miniApp.url}/`);
  url.searchParams.set("session_id", sessionId);
  if (file) {
    url.searchParams.set("file", file);
  }
  return url.toString();
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
