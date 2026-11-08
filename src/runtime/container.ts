import { existsSync } from "node:fs";

export const OPENCODE_TELEGRAM_CONTAINER_ENV = "OPENCODE_TELEGRAM_CONTAINER";

export interface ContainerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  dockerEnvExists?: () => boolean;
}

function isEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function isContainerRuntime(options?: ContainerRuntimeOptions): boolean {
  const env = options?.env ?? process.env;
  const configuredFlag = env[OPENCODE_TELEGRAM_CONTAINER_ENV];
  if (configuredFlag !== undefined) {
    return isEnabledFlag(configuredFlag);
  }

  const dockerEnvExists = options?.dockerEnvExists ?? (() => existsSync("/.dockerenv"));
  return dockerEnvExists();
}
