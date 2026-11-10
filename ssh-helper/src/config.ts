import fs from "node:fs";
import net from "node:net";
import type { HelperConfig } from "./types.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (!value) throw new Error(`Missing required helper configuration: ${name}`);
  return value;
}

function port(env: NodeJS.ProcessEnv): number {
  const value = env.SSH_HELPER_PORT?.trim() || "3110";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("SSH_HELPER_PORT must be between 1 and 65535");
  }
  return parsed;
}

function existingFile(env: NodeJS.ProcessEnv, name: string): string {
  const filePath = required(env, name);
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`${name} is not readable: ${filePath}`);
  }
  return filePath;
}

function allowedAddress(env: NodeJS.ProcessEnv): string {
  const value = required(env, "SSH_HELPER_ALLOWED_TRAEFIK_ADDRESS");
  if (net.isIP(value) === 0)
    throw new Error("SSH_HELPER_ALLOWED_TRAEFIK_ADDRESS must be an IP address");
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HelperConfig {
  return {
    bindHost: env.SSH_HELPER_BIND_HOST?.trim() || "0.0.0.0",
    port: port(env),
    sshKeyPath: existingFile(env, "SSH_KEY_PATH"),
    agentSocket: required(env, "SSH_AGENT_SOCKET"),
    encryptionKeyFile: existingFile(env, "SSH_HELPER_ENCRYPTION_KEY_FILE"),
    botSigningPublicKeyFile: existingFile(env, "SSH_HELPER_BOT_SIGNING_PUBLIC_KEY_FILE"),
    allowedTraefikAddress: allowedAddress(env),
  };
}
