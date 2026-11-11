import type {
  SshAuthorizationResponse,
  SshPublicKeyResponse,
  SshStatusResponse,
  SshUnlockEnvelope,
} from "./ssh-types.js";
import { SshApiError } from "./ssh-types.js";

const API_ROOT = "/mini-app/api/ssh";

export async function fetchSshPublicKey(): Promise<SshPublicKeyResponse> {
  return request(`${API_ROOT}/public-key`, "GET");
}

export async function authorizeSshUnlock(): Promise<SshAuthorizationResponse> {
  return request(`${API_ROOT}/authorize`, "POST", {});
}

export async function fetchSshStatus(): Promise<SshStatusResponse> {
  return request(`${API_ROOT}/status`, "GET");
}

export async function unlockSsh(
  requestId: string,
  authorizationToken: string,
  envelope: SshUnlockEnvelope,
): Promise<SshStatusResponse> {
  return request(`${API_ROOT}/unlock`, "POST", { requestId, authorizationToken, envelope });
}

export async function lockSsh(): Promise<SshStatusResponse> {
  return request(`${API_ROOT}/lock`, "POST", {});
}

async function request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  if (!initData) {
    throw new SshApiError("unauthorized", "Open this screen from Telegram.");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        "X-Telegram-Init-Data": initData,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    throw new SshApiError("unavailable", "The SSH helper could not be reached.");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      isRecord(payload) && typeof payload.code === "string" ? payload.code : "unavailable";
    const message =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : "The SSH operation failed.";
    throw new SshApiError(code, message, response.status);
  }

  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
