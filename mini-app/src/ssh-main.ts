import { authorizeSshUnlock, fetchSshStatus, lockSsh, unlockSsh } from "./ssh-api.js";
import { encryptPassphrase } from "./ssh-crypto.js";
import { SshApiError, type SshStatusResponse } from "./ssh-types.js";

const elements = {
  state: requiredElement("ssh-state"),
  stateTitle: requiredElement("ssh-state-title"),
  stateMessage: requiredElement("ssh-state-message"),
  passphrase: requiredInput("ssh-passphrase"),
  unlock: requiredButton("ssh-unlock"),
  lock: requiredButton("ssh-lock"),
  refresh: requiredButton("ssh-refresh"),
  fingerprint: requiredElement("ssh-fingerprint"),
};

let status: SshStatusResponse | null = null;

setupTelegram();
elements.unlock.addEventListener("click", () => void unlock());
elements.lock.addEventListener("click", () => void lock());
elements.refresh.addEventListener("click", () => void refresh());
void refresh();

async function refresh(): Promise<void> {
  setBusy(true);
  showState("loading", "Loading SSH status", "Checking the local ssh-agent.");
  try {
    status = await fetchSshStatus();
    renderStatus();
  } catch (error) {
    status = null;
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function unlock(): Promise<void> {
  const passphrase = elements.passphrase.value;
  if (!passphrase) {
    showState("unavailable", "Passphrase required", "Enter the SSH key passphrase to continue.");
    return;
  }

  setBusy(true);
  try {
    const authorization = await authorizeSshUnlock();
    const envelope = await encryptPassphrase(
      authorization.publicKey,
      authorization.keyId,
      authorization.requestId,
      authorization.expiresAt,
      passphrase,
    );
    status = await unlockSsh(authorization.requestId, authorization.authorizationToken, envelope);
    renderStatus();
  } catch (error) {
    showError(error);
  } finally {
    elements.passphrase.value = "";
    setBusy(false);
  }
}

async function lock(): Promise<void> {
  setBusy(true);
  try {
    status = await lockSsh();
    renderStatus();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

function renderStatus(): void {
  if (status === null) return;
  const unlocked = status.state === "unlocked";
  showState(
    unlocked ? "unlocked" : "locked",
    unlocked ? "SSH key unlocked" : "SSH key locked",
    unlocked
      ? "OpenCode can use the configured key through ssh-agent."
      : "Unlock the key before starting Git work.",
  );
  elements.fingerprint.textContent = status.fingerprint
    ? `Fingerprint: ${status.fingerprint}`
    : `Key ID: ${status.keyId}`;
}

function showError(error: unknown): void {
  const message = error instanceof SshApiError ? error.message : "The SSH operation failed.";
  showState("unavailable", "SSH unavailable", message);
  elements.fingerprint.textContent = "";
}

function showState(state: string, title: string, message: string): void {
  elements.state.hidden = false;
  elements.state.dataset.state = state;
  elements.stateTitle.textContent = title;
  elements.stateMessage.textContent = message;
}

function setBusy(busy: boolean): void {
  elements.unlock.disabled = busy;
  elements.lock.disabled = busy;
  elements.refresh.disabled = busy;
}

function setupTelegram(): void {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
  applyTelegramTheme();
  webApp.onEvent("themeChanged", applyTelegramTheme);
}

function applyTelegramTheme(): void {
  const themeParams = window.Telegram?.WebApp?.themeParams;
  if (!themeParams) return;
  for (const [key, value] of Object.entries(themeParams)) {
    if (value !== undefined) {
      document.documentElement.style.setProperty(`--tg-theme-${key.replaceAll("_", "-")}`, value);
    }
  }
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing SSH Mini App element: ${id}`);
  return element;
}

function requiredInput(id: string): HTMLInputElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`SSH element is not an input: ${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`SSH element is not a button: ${id}`);
  return element;
}
