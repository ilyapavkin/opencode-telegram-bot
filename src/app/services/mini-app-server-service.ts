import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { MiniAppAuthError, validateMiniAppInitData } from "./mini-app-auth-service.js";
import { MiniAppDiffError, loadMiniAppChange, loadMiniAppDiff } from "./mini-app-diff-service.js";

const CLOSE_CONNECTIONS_TIMEOUT_MS = 2000;
const MINI_APP_ROOT = "/mini-app";

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

  constructor(staticRoot?: string) {
    this.staticRoot = staticRoot ?? null;
  }

  async start(): Promise<void> {
    if (!config.miniApp.enabled) {
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
    logger.info(
      `[MiniApp] Listening on ${config.miniApp.bindHost}:${config.miniApp.port} (${config.miniApp.url})`,
    );
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
    if (req.method !== "GET") {
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
      await this.handleDiffRequest(req, res, url);
      return;
    }

    if (url.pathname === MINI_APP_ROOT) {
      res.writeHead(308, { Location: `${MINI_APP_ROOT}/` });
      res.end();
      return;
    }

    if (
      url.pathname === `${MINI_APP_ROOT}/` ||
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
    const initData = req.headers["x-telegram-init-data"];
    if (typeof initData !== "string") {
      sendJson(res, 401, { code: "unauthorized", message: "Telegram authentication is required" });
      return;
    }

    try {
      validateMiniAppInitData(
        initData,
        config.telegram.token,
        config.telegram.allowedUserId,
        config.miniApp.initDataMaxAgeSec,
      );
    } catch (error) {
      if (error instanceof MiniAppAuthError) {
        logger.warn(`[MiniApp] Authentication rejected: ${error.message}`);
        sendJson(res, 401, {
          code: "unauthorized",
          message: "Telegram authentication was rejected",
        });
        return;
      }
      sendJson(res, 500, { code: "internal_error", message: "Unable to authenticate request" });
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

  private async serveStatic(res: http.ServerResponse, requestPath: string): Promise<void> {
    const root = this.getStaticRoot();
    const relativePath =
      requestPath === `${MINI_APP_ROOT}/`
        ? "index.html"
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
      requestPath === `${MINI_APP_ROOT}/` ? decodedPath : path.join("assets", decodedPath),
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
        "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
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
