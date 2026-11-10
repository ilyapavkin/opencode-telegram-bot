import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { MiniAppAuthError, validateMiniAppInitData } from "./mini-app-auth-service.js";
import { MiniAppDiffError, loadMiniAppChange, loadMiniAppDiff } from "./mini-app-diff-service.js";
import { SshUnlockService, SshUnlockServiceError } from "./ssh-unlock-service.js";
import type { SshUnlockEnvelope } from "../types/ssh.js";

const CLOSE_CONNECTIONS_TIMEOUT_MS = 2000;
const MINI_APP_ROOT = "/mini-app";
const SSH_MINI_APP_ROOT = `${MINI_APP_ROOT}/ssh`;
const MAX_SSH_REQUEST_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export class MiniAppServer {
  private server: http.Server | null = null;
  private staticRoot: string | null = null;

  constructor(
    staticRoot?: string,
    private readonly sshUnlockService?: SshUnlockService,
  ) {
    this.staticRoot = staticRoot ?? null;
  }

  async start(): Promise<void> {
    if (!config.miniApp.enabled && !config.ssh?.enabled) {
      logger.info("[MiniApp] Mini App server disabled");
      return;
    }
    if (this.server) {
      logger.warn("[MiniApp] Mini App server already running");
      return;
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.miniApp.port, config.miniApp.bindHost, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      logger.error(
        `[MiniApp] Could not listen on ${config.miniApp.bindHost}:${config.miniApp.port}`,
        error,
      );
      throw error;
    }

    server.on("error", (error) => {
      logger.error("[MiniApp] Mini App server error", error);
    });
    logger.info(`[MiniApp] Listening on ${config.miniApp.bindHost}:${config.miniApp.port}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, CLOSE_CONNECTIONS_TIMEOUT_MS).unref();
    });
    logger.info("[MiniApp] Mini App server stopped");
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 405, { code: "method_not_allowed", message: "Method not allowed" });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://mini-app.local");
    } catch {
      sendJson(res, 400, { code: "invalid_request", message: "Invalid request URL" });
      return;
    }

    if (
      url.pathname === `${MINI_APP_ROOT}/api/diff` ||
      url.pathname === `${MINI_APP_ROOT}/api/change`
    ) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      await this.handleDiffRequest(req, res, url);
      return;
    }

    if (url.pathname.startsWith(`${MINI_APP_ROOT}/api/ssh/`)) {
      await this.handleSshRequest(req, res, url);
      return;
    }

    if (url.pathname === MINI_APP_ROOT) {
      res.writeHead(308, { Location: `${MINI_APP_ROOT}/` });
      res.end();
      return;
    }

    if (url.pathname === SSH_MINI_APP_ROOT) {
      res.writeHead(308, { Location: `${SSH_MINI_APP_ROOT}/` });
      res.end();
      return;
    }

    if (
      url.pathname === `${MINI_APP_ROOT}/` ||
      url.pathname === `${SSH_MINI_APP_ROOT}/` ||
      url.pathname.startsWith(`${MINI_APP_ROOT}/assets/`)
    ) {
      await this.serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 404, { code: "not_found", message: "Not found" });
  }

  private async handleDiffRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.authenticate(req, false)) {
      sendJson(res, 401, { code: "unauthorized", message: "Telegram authentication is required" });
      return;
    }

    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) {
      sendJson(res, 400, { code: "invalid_request", message: "session_id is required" });
      return;
    }

    try {
      const messageId = url.searchParams.get("message_id");
      const callId = url.searchParams.get("call_id");
      let response;
      if (url.pathname === `${MINI_APP_ROOT}/api/change`) {
        if (!messageId || !callId) {
          throw new MiniAppDiffError(
            "invalid_selector",
            "message_id and call_id are required",
            400,
          );
        }
        response = await loadMiniAppChange(
          sessionId,
          messageId,
          callId,
          url.searchParams.get("file"),
        );
      } else {
        response = await loadMiniAppDiff(sessionId, url.searchParams.get("file"));
      }
      sendJson(res, 200, response);
    } catch (error) {
      if (error instanceof MiniAppDiffError) {
        sendJson(res, error.statusCode, {
          code: error.code,
          message: error.message,
        });
        return;
      }

      logger.error("[MiniApp] Failed to load session diff", error);
      sendJson(res, 500, { code: "internal_error", message: "Unable to load the session diff" });
    }
  }

  private async handleSshRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.sshUnlockService) {
      sendJson(res, 404, { code: "not_found", message: "Not found" });
      return;
    }

    const auth = this.authenticate(req, true);
    if (!auth) {
      req.resume();
      sendJson(res, 401, {
        code: "unauthorized",
        message: "Telegram authentication was rejected",
      });
      return;
    }

    try {
      switch (url.pathname) {
        case `${MINI_APP_ROOT}/api/ssh/public-key`:
          if (req.method !== "GET") return methodNotAllowed(res);
          sendJson(res, 200, await this.sshUnlockService.publicKey());
          return;
        case `${MINI_APP_ROOT}/api/ssh/authorize`:
          if (req.method !== "POST") return methodNotAllowed(res);
          req.resume();
          sendJson(res, 200, await this.sshUnlockService.authorize(auth.userId));
          return;
        case `${MINI_APP_ROOT}/api/ssh/status`:
          if (req.method !== "GET") return methodNotAllowed(res);
          sendJson(res, 200, await this.sshUnlockService.status());
          return;
        case `${MINI_APP_ROOT}/api/ssh/unlock`:
          if (req.method !== "POST") return methodNotAllowed(res);
          await this.handleSshUnlock(req, res, auth.userId);
          return;
        case `${MINI_APP_ROOT}/api/ssh/lock`:
          if (req.method !== "POST") return methodNotAllowed(res);
          req.resume();
          sendJson(res, 200, await this.sshUnlockService.lock());
          return;
        default:
          sendJson(res, 404, { code: "not_found", message: "Not found" });
      }
    } catch (error) {
      if (error instanceof SshUnlockServiceError) {
        sendJson(res, error.statusCode, { code: error.code, message: error.message });
        return;
      }
      logger.error("[MiniApp] SSH operation failed", error);
      sendJson(res, 503, { code: "unavailable", message: "SSH helper is unavailable" });
    }
  }

  private async handleSshUnlock(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    userId: number,
  ): Promise<void> {
    const service = this.sshUnlockService;
    if (!service) {
      sendJson(res, 404, { code: "not_found", message: "Not found" });
      return;
    }
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      sendJson(res, 400, { code: "invalid_request", message: "Invalid unlock request" });
      return;
    }

    const requestId = body.requestId;
    const authorizationToken = body.authorizationToken;
    const envelope = body.envelope;
    if (
      typeof requestId !== "string" ||
      typeof authorizationToken !== "string" ||
      !isRecord(envelope)
    ) {
      sendJson(res, 400, { code: "invalid_request", message: "Invalid unlock request" });
      return;
    }

    sendJson(
      res,
      200,
      await service.unlock(
        userId,
        requestId,
        authorizationToken,
        envelope as unknown as SshUnlockEnvelope,
      ),
    );
  }

  private authenticate(req: http.IncomingMessage, sshRequest: boolean): { userId: number } | null {
    const initData = req.headers["x-telegram-init-data"];
    if (typeof initData !== "string") {
      return null;
    }

    try {
      return validateMiniAppInitData(
        initData,
        config.telegram.token,
        config.telegram.allowedUserId,
        sshRequest
          ? Math.min(config.miniApp.initDataMaxAgeSec, config.ssh.unlockRequestTtlSec)
          : config.miniApp.initDataMaxAgeSec,
      );
    } catch (error) {
      if (!(error instanceof MiniAppAuthError)) {
        logger.error("[MiniApp] Unexpected authentication failure", error);
      }
      return null;
    }
  }

  private async serveStatic(res: http.ServerResponse, requestPath: string): Promise<void> {
    const root = this.getStaticRoot();
    const relativePath =
      requestPath === `${MINI_APP_ROOT}/`
        ? "index.html"
        : requestPath === `${SSH_MINI_APP_ROOT}/`
          ? "ssh.html"
          : requestPath.slice(`${MINI_APP_ROOT}/assets/`.length);

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(relativePath);
    } catch {
      sendJson(res, 400, { code: "invalid_request", message: "Invalid asset path" });
      return;
    }

    const filePath = path.resolve(
      root,
      requestPath === `${MINI_APP_ROOT}/` || requestPath === `${SSH_MINI_APP_ROOT}/`
        ? decodedPath
        : path.join("assets", decodedPath),
    );
    const relative = path.relative(root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      sendJson(res, 404, { code: "not_found", message: "Not found" });
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      const contentType =
        CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": body.byteLength,
        "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=3600",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self';",
      });
      res.end(body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(res, 404, { code: "not_found", message: "Not found" });
        return;
      }
      logger.error("[MiniApp] Failed to serve static asset", error);
      sendJson(res, 500, { code: "internal_error", message: "Unable to serve Mini App" });
    }
  }

  private getStaticRoot(): string {
    if (this.staticRoot) {
      return this.staticRoot;
    }

    const compiledRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../mini-app",
    );
    if (existsSync(compiledRoot)) {
      return compiledRoot;
    }

    return path.resolve(process.cwd(), "mini-app");
  }
}

function methodNotAllowed(res: http.ServerResponse): void {
  sendJson(res, 405, { code: "method_not_allowed", message: "Method not allowed" });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_SSH_REQUEST_BODY_BYTES) {
    req.resume();
    throw new SshUnlockServiceError("Unlock request is too large", 413, "invalid_request");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_SSH_REQUEST_BODY_BYTES) {
      throw new SshUnlockServiceError("Unlock request is too large", 413, "invalid_request");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SshUnlockServiceError("Invalid unlock request", 400, "invalid_request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
