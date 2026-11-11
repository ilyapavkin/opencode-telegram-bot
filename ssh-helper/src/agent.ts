import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import type { HelperConfig, HelperStatus } from "./types.js";

const execFileAsync = promisify(execFile);

export interface AgentController {
  status(): Promise<HelperStatus["state"]>;
  fingerprint(): Promise<string | null>;
  unlock(passphrase: Buffer): Promise<string>;
  lock(): Promise<void>;
}

export function createAgentController(config: HelperConfig): AgentController {
  const environment = { ...process.env, SSH_AUTH_SOCK: config.agentSocket };
  const askpassPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../askpass.sh");

  return {
    async status() {
      try {
        await execFileAsync("ssh-add", ["-l"], { env: environment });
        return "unlocked";
      } catch (error) {
        const exitCode = getExitCode(error);
        if (exitCode === 1) return "locked";
        throw new Error("ssh-agent is unavailable");
      }
    },

    async fingerprint() {
      if ((await this.status()) === "locked") return null;
      try {
        const { stdout } = await execFileAsync("ssh-keygen", ["-lf", config.sshKeyPath], {
          env: environment,
        });
        const fingerprint = stdout.trim().split(/\s+/u)[1];
        return fingerprint ?? null;
      } catch {
        throw new Error("Unable to read SSH key fingerprint");
      }
    },

    async unlock(passphrase) {
      const child = spawn("ssh-add", [config.sshKeyPath], {
        env: {
          ...environment,
          DISPLAY: ":0",
          SSH_ASKPASS: askpassPath,
          SSH_ASKPASS_REQUIRE: "force",
        },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const output = collectOutput(child);
      const secretPipe = child.stdio[3];
      if (!(secretPipe instanceof Writable)) {
        child.kill();
        throw new Error("Unable to initialize SSH askpass channel");
      }
      secretPipe.end(passphrase);
      passphrase.fill(0);
      const exitCode = await waitForExit(child);
      if (exitCode !== 0) {
        throw new Error(`ssh-add failed: ${sanitizeOutput(await output)}`);
      }
      const fingerprint = await this.fingerprint();
      if (!fingerprint) throw new Error("ssh-add loaded no identity");
      return fingerprint;
    },

    async lock() {
      try {
        await execFileAsync("ssh-add", ["-d", config.sshKeyPath], { env: environment });
      } catch (error) {
        if (getExitCode(error) !== 1) throw new Error("Unable to remove SSH identity");
      }
    },
  };
}

function collectOutput(child: ReturnType<typeof spawn>): Promise<string> {
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve) =>
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8"))),
  );
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function getExitCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const code = Reflect.get(error, "code");
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d+$/u.test(code)) return Number(code);
  return null;
}

function sanitizeOutput(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 200) || "unknown error";
}
