import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MiniAppAuthError,
  validateMiniAppInitData,
} from "../../../src/app/services/mini-app-auth-service.js";

const BOT_TOKEN = "123456:secret-token";
const ALLOWED_USER_ID = 987654321;
const NOW = 1_700_000_000;

function makeInitData(overrides: Record<string, string> = {}): string {
  const values = {
    auth_date: String(NOW - 30),
    query_id: "query-1",
    user: JSON.stringify({ id: ALLOWED_USER_ID, first_name: "Test" }),
    ...overrides,
  };
  const dataCheckString = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", BOT_TOKEN).update("WebAppData").digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...values, hash }).toString();
}

describe("mini-app auth", () => {
  it("accepts valid Telegram Web App initData", () => {
    expect(validateMiniAppInitData(makeInitData(), BOT_TOKEN, ALLOWED_USER_ID, 3600, NOW)).toEqual({
      userId: ALLOWED_USER_ID,
    });
  });

  it.each([
    ["tampered signature", () => makeInitData().replace(/hash=[^&]+/, "hash=00")],
    ["expired data", () => makeInitData({ auth_date: String(NOW - 3601) })],
    ["unauthorized user", () => makeInitData({ user: JSON.stringify({ id: 123 }) })],
    ["malformed user", () => makeInitData({ user: "not-json" })],
  ])("rejects %s", (_name, buildData) => {
    expect(() =>
      validateMiniAppInitData(buildData(), BOT_TOKEN, ALLOWED_USER_ID, 3600, NOW),
    ).toThrow(MiniAppAuthError);
  });

  it("rejects missing authentication data", () => {
    expect(() => validateMiniAppInitData("", BOT_TOKEN, ALLOWED_USER_ID, 3600, NOW)).toThrow(
      MiniAppAuthError,
    );
  });
});
