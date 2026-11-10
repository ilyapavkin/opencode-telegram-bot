import { createHmac, timingSafeEqual } from "node:crypto";

export class MiniAppAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniAppAuthError";
  }
}

export interface MiniAppAuthResult {
  userId: number;
}

export function validateMiniAppInitData(
  initData: string,
  botToken: string,
  allowedUserId: number,
  maxAgeSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): MiniAppAuthResult {
  if (!initData || !botToken) {
    throw new MiniAppAuthError("Missing Telegram Web App authentication data");
  }

  const params = new URLSearchParams(initData);
  if (params.getAll("hash").length !== 1) {
    throw new MiniAppAuthError("Malformed Telegram Web App authentication data");
  }
  const hash = params.get("hash");
  const authDate = parseAuthDate(params.get("auth_date"));
  const userId = parseUserId(params.get("user"));

  if (!hash || !authDate || userId === null) {
    throw new MiniAppAuthError("Malformed Telegram Web App authentication data");
  }

  const ageSec = nowSec - authDate;
  if (ageSec > maxAgeSec || ageSec < -60) {
    throw new MiniAppAuthError("Telegram Web App authentication data has expired");
  }

  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", botToken).update("WebAppData").digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!secureHashEquals(hash, expectedHash)) {
    throw new MiniAppAuthError("Invalid Telegram Web App signature");
  }

  if (userId !== allowedUserId) {
    throw new MiniAppAuthError("Unauthorized Telegram user");
  }

  return { userId };
}

function parseAuthDate(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseUserId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  try {
    const user = JSON.parse(value) as unknown;
    if (typeof user !== "object" || user === null || !("id" in user)) {
      return null;
    }

    const id = (user as { id?: unknown }).id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function secureHashEquals(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(actual)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
