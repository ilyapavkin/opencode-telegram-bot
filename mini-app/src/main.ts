import { fetchDiff } from "./api.js";
import { collapseContext, collapseSideBySide, parsePatch, toSideBySide } from "./parser.js";
import type { PatchLine, SideBySideRow } from "./parser.js";
import { readLaunchSelection, selectFile } from "./selection.js";
import { ApiError } from "./types.js";
import type { DiffFile, DiffResponse } from "./types.js";

const selection = readLaunchSelection(window.location.href);
const elements = {
  state: requiredElement("state"),
  stateTitle: requiredElement("state-title"),
  stateMessage: requiredElement("state-message"),
  workspace: requiredElement("workspace"),
  sessionTitle: requiredElement("session-title"),
  sessionMeta: requiredElement("session-meta"),
  fileCount: requiredElement("file-count"),
  fileList: requiredElement("file-list"),
  selectedFile: requiredElement("selected-file"),
  fileStatus: requiredElement("file-status"),
  fileTitle: requiredElement("file-title"),
  fileStats: requiredElement("file-stats"),
  diffView: requiredElement("diff-view"),
  unifiedButton: requiredButton("unified-button"),
  splitButton: requiredButton("split-button"),
  copyButton: requiredButton("copy-button"),
  downloadButton: requiredButton("download-button"),
  refreshButton: requiredButton("refresh-button"),
};

let response: DiffResponse | null = null;
let selectedFile: DiffFile | null = null;
let requestedFileMissing = false;
let viewMode: "unified" | "side-by-side" = "unified";
let expandedContext = false;
let requestNumber = 0;

setupTelegram();
elements.unifiedButton.addEventListener("click", () => {
  viewMode = "unified";
  updateViewButtons();
  renderDiff();
});
elements.splitButton.addEventListener("click", () => {
  viewMode = "side-by-side";
  updateViewButtons();
  renderDiff();
});
elements.copyButton.addEventListener("click", () => void copyPatch());
elements.downloadButton.addEventListener("click", downloadPatch);
elements.refreshButton.addEventListener("click", () => void loadDiff());
void loadDiff();

async function loadDiff(): Promise<void> {
  const currentRequest = ++requestNumber;
  expandedContext = false;
  elements.refreshButton.disabled = true;
  elements.workspace.hidden = true;
  elements.selectedFile.hidden = true;
  showState("loading", "Loading diff", "Fetching the current session changes.");

  try {
    const nextResponse = await fetchDiff(selection);
    if (currentRequest !== requestNumber) return;
    response = nextResponse;
    const selected = selectFile(response.files, selection.filePath, response.selectedFile);
    selectedFile = selected.file;
    requestedFileMissing = selected.requestedFileMissing;
    renderSession();
    renderFileList();
    renderLoadedState();
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    response = null;
    selectedFile = null;
    requestedFileMissing = false;
    const apiError =
      error instanceof ApiError
        ? error
        : new ApiError("unavailable", "The diff service is unavailable right now.");
    showState(apiError.kind, titleForFailure(apiError.kind), apiError.message);
  } finally {
    if (currentRequest === requestNumber) elements.refreshButton.disabled = false;
  }
}

function renderSession(): void {
  if (response === null) return;
  elements.sessionTitle.textContent = response.session.title;
  const details = [response.session.project];
  if (response.session.branch !== null) details.push(response.session.branch);
  elements.sessionMeta.textContent = details.join(" / ");
}

function renderFileList(): void {
  if (response === null) return;
  elements.fileCount.textContent = String(response.files.length);
  elements.fileList.replaceChildren();

  for (const file of response.files) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-button";
    if (file === selectedFile) button.classList.add("is-selected");
    button.setAttribute("aria-label", `Open ${file.path}`);
    button.addEventListener("click", () => {
      selectedFile = file;
      requestedFileMissing = false;
      expandedContext = false;
      selection.filePath = file.path;
      const url = new URL(window.location.href);
      url.searchParams.set("file", file.path);
      window.history.replaceState(null, "", url);
      renderFileList();
      renderLoadedState();
    });

    const path = document.createElement("span");
    path.className = "file-path";
    path.textContent = file.path;
    const counts = document.createElement("span");
    counts.className = "file-counts";
    counts.append(
      createCount("+", file.additions, "addition-count"),
      createCount("-", file.deletions, "deletion-count"),
    );
    button.append(path, counts);
    item.append(button);
    elements.fileList.append(item);
  }
}

function renderLoadedState(): void {
  if (response === null) return;
  elements.workspace.hidden = false;
  if (response.files.length === 0) {
    elements.selectedFile.hidden = true;
    showState("empty", "No changes", "This session has no changed files.");
    return;
  }
  if (requestedFileMissing) {
    elements.selectedFile.hidden = true;
    showState(
      "unavailable",
      "File unavailable",
      "That file is not part of the current session diff.",
    );
    return;
  }
  if (selectedFile === null || selectedFile.patch === null || selectedFile.patch === "") {
    elements.selectedFile.hidden = true;
    showState(
      "empty",
      "No patch content",
      selectedFile?.reason ?? "This file has no text patch to display.",
    );
    return;
  }

  elements.state.hidden = true;
  elements.selectedFile.hidden = false;
  elements.fileStatus.textContent = selectedFile.status;
  elements.fileTitle.textContent = selectedFile.path;
  elements.fileStats.textContent = `+${selectedFile.additions}  -${selectedFile.deletions}`;
  elements.copyButton.disabled = false;
  elements.downloadButton.disabled = false;
  renderDiff();
}

function renderDiff(): void {
  if (
    selectedFile?.patch === null ||
    selectedFile?.patch === undefined ||
    selectedFile.patch === ""
  )
    return;
  const lines = parsePatch(selectedFile.patch);
  elements.diffView.replaceChildren();
  if (viewMode === "unified") {
    const segments = expandedContext ? [{ type: "lines" as const, lines }] : collapseContext(lines);
    for (const segment of segments) {
      if (segment.type === "collapsed") {
        elements.diffView.append(createContextToggle(segment.count));
      } else {
        for (const line of segment.lines) elements.diffView.append(createUnifiedLine(line));
      }
    }
  } else {
    const rows = toSideBySide(lines);
    const visibleRows = expandedContext ? rows : collapseSideBySide(rows);
    for (const row of visibleRows) {
      if (row.kind === "collapsed") {
        elements.diffView.append(createContextToggle(row.count));
      } else {
        elements.diffView.append(createSplitRow(row));
      }
    }
  }
}

function createUnifiedLine(line: PatchLine): HTMLDivElement {
  const element = document.createElement("div");
  element.className = `diff-line ${line.kind}`;
  if (line.kind === "hunk" || line.kind === "meta") {
    element.textContent = line.raw;
    return element;
  }

  const oldNumber = document.createElement("span");
  oldNumber.className = "line-number";
  oldNumber.textContent = line.oldLine === null ? "" : String(line.oldLine);
  const newNumber = document.createElement("span");
  newNumber.className = "line-number";
  newNumber.textContent = line.newLine === null ? "" : String(line.newLine);
  const marker = document.createElement("span");
  marker.className = "line-marker";
  marker.textContent = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
  const content = document.createElement("span");
  content.className = "line-content";
  content.textContent = line.text;
  element.append(oldNumber, newNumber, marker, content);
  return element;
}

function createSplitRow(row: SideBySideRow): HTMLDivElement {
  const element = document.createElement("div");
  element.className = `split-row ${row.kind}`;
  if (row.kind === "hunk" || row.kind === "meta") {
    const content = document.createElement("div");
    content.className = "split-cell";
    content.textContent = row.left?.raw ?? row.right?.raw ?? "";
    element.append(content);
    return element;
  }
  element.append(createSplitCell(row.left, "left"), createSplitCell(row.right, "right"));
  return element;
}

function createSplitCell(line: PatchLine | null, side: "left" | "right"): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = `split-cell ${line?.kind ?? "empty"}`;
  if (line === null) return cell;

  const number = document.createElement("span");
  number.className = "line-number";
  number.textContent = String(side === "left" ? (line.oldLine ?? "") : (line.newLine ?? ""));
  const marker = document.createElement("span");
  marker.className = "line-marker";
  marker.textContent = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
  const content = document.createElement("span");
  content.className = "line-content";
  content.textContent = line.text;
  cell.append(number, marker, content);
  return cell;
}

function createContextToggle(count: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "context-toggle";
  button.textContent = expandedContext
    ? "Hide unchanged context"
    : `Show ${count} unchanged line${count === 1 ? "" : "s"}`;
  button.setAttribute("aria-expanded", String(expandedContext));
  button.addEventListener("click", () => {
    expandedContext = !expandedContext;
    renderDiff();
  });
  return button;
}

async function copyPatch(): Promise<void> {
  if (selectedFile?.patch === null || selectedFile?.patch === undefined) return;
  try {
    await navigator.clipboard.writeText(selectedFile.patch);
    const original = elements.copyButton.textContent;
    elements.copyButton.textContent = "Copied";
    window.setTimeout(() => {
      elements.copyButton.textContent = original;
    }, 1200);
  } catch {
    elements.copyButton.textContent = "Copy failed";
    window.setTimeout(() => {
      elements.copyButton.textContent = "Copy patch";
    }, 1600);
  }
}

function downloadPatch(): void {
  if (selectedFile?.patch === null || selectedFile?.patch === undefined) return;
  const blob = new Blob([selectedFile.patch], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName(selectedFile.path)}.patch`;
  link.click();
  URL.revokeObjectURL(url);
}

function setupTelegram(): void {
  const webApp = window.Telegram?.WebApp;
  if (webApp === undefined) return;
  webApp.ready();
  webApp.expand();
  applyTelegramTheme();
  webApp.onEvent("themeChanged", applyTelegramTheme);
}

function applyTelegramTheme(): void {
  const themeParams = window.Telegram?.WebApp?.themeParams;
  if (themeParams === undefined) return;
  for (const [key, value] of Object.entries(themeParams)) {
    if (value !== undefined)
      document.documentElement.style.setProperty(`--tg-theme-${key.replaceAll("_", "-")}`, value);
  }
}

function showState(
  state: "loading" | "unauthorized" | "unavailable" | "oversized" | "empty",
  title: string,
  message: string,
): void {
  elements.state.hidden = false;
  elements.state.dataset.state = state;
  elements.stateTitle.textContent = title;
  elements.stateMessage.textContent = message;
  elements.copyButton.disabled = true;
  elements.downloadButton.disabled = true;
}

function updateViewButtons(): void {
  elements.unifiedButton.classList.toggle("is-active", viewMode === "unified");
  elements.splitButton.classList.toggle("is-active", viewMode === "side-by-side");
}

function titleForFailure(kind: ApiError["kind"]): string {
  if (kind === "unauthorized") return "Authentication required";
  if (kind === "oversized") return "Diff is too large";
  return "Diff unavailable";
}

function createCount(marker: string, count: number, className: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = `${marker}${count}`;
  return element;
}

function fileName(path: string): string {
  const name = path.split(/[\\/]/u).at(-1) ?? "changes";
  return name.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing Mini App element: ${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`Mini App element is not a button: ${id}`);
  return element;
}
