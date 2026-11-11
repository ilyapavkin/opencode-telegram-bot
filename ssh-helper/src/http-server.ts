import http from "node:http";
import type { KeyObject } from "node:crypto";
import { decryptPassphrase, verifySignedRequest, type EncryptionKeys } from "./crypto.js";
import type { AgentController } from "./agent.js";
import { error, info } from "./logger.js";
import type { HelperConfig, HelperStatus, SignedRequest, UnlockEnvelope } from "./types.js";

const CLOSE_CONNECTIONS_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 64 * 1024;

export function createRequestHandler(
  config: HelperConfig,
  keys: EncryptionKeys,
  signingPublicKey: KeyObject,
  agent: AgentController,
): http.RequestListener {
  const usedRequests = new Map<string, number>();

  return (req, res) => {
    void handleRequest(req, res, config, keys, signingPublicKey, agent, usedRequests).catch(
      (cause) => {
        error("Unhandled request error", cause);
        if (!res.headersSent) sendJson(res, 500, { error: "Internal helper error" });
        else res.destroy();
      },
    );
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: HelperConfig,
  keys: EncryptionKeys,
  signingPublicKey: KeyObject,
  agent: AgentController,
  usedRequests: Map<string, number>,
): Promise<void> {
  const requestPath = (req.url ?? "/").split("?", 1)[0] ?? "/";
  if (requestPath === "/health/live") {
    if (req.method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, { status: "healthy" });
    return;
  }

  const remoteAddress = req.socket.remoteAddress?.replace(/^::ffff:/u, "");
  if (remoteAddress !== config.allowedTraefikAddress) {
    req.resume();
    return sendJson(res, 403, { error: "Forbidden" });
  }

  const operation = operationFor(requestPath);
  if (!operation) return sendJson(res, 404, { error: "Not found" });
  if ((operation === "public_key" || operation === "status") && req.method !== "GET") {
    return methodNotAllowed(res);
  }
  if ((operation === "unlock" || operation === "lock") && req.method !== "POST") {
    return methodNotAllowed(res);
  }

  let body: unknown;
  try {
    body = req.method === "POST" ? await readJsonBody(req) : null;
  } catch {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  let signedRequest: SignedRequest;
  let signature: string;
  try {
    signedRequest = readSignedRequest(req, operation, body);
    signature = header(req, "x-ssh-signature");
  } catch {
    return sendJson(res, 401, { error: "Invalid signed request" });
  }
  const now = Math.floor(Date.now() / 1000);
  if (signedRequest.expiresAt < now || signedRequest.expiresAt > now + 60) {
    return sendJson(res, 401, { error: "Request expired" });
  }
  if (!verifySignedRequest(signedRequest, signature, signingPublicKey)) {
    return sendJson(res, 401, { error: "Invalid request signature" });
  }
  pruneUsedRequests(usedRequests, now);
  if (usedRequests.has(signedRequest.requestId)) {
    return sendJson(res, 409, { error: "Request already used" });
  }
  usedRequests.set(signedRequest.requestId, signedRequest.expiresAt);

  switch (operation) {
    case "public_key":
      sendJson(res, 200, { keyId: keys.keyId, publicKey: keys.publicKey });
      return;
    case "status":
      sendJson(res, 200, await buildStatus(agent, keys.keyId));
      return;
    case "lock":
      await agent.lock();
      sendJson(res, 200, await buildStatus(agent, keys.keyId));
      info("SSH key lock requested");
      return;
    case "unlock":
      await handleUnlock(res, signedRequest, keys, agent);
      return;
  }
}

async function handleUnlock(
  res: http.ServerResponse,
  request: SignedRequest,
  keys: EncryptionKeys,
  agent: AgentController,
): Promise<void> {
  if (!isRecord(request.body)) return sendJson(res, 400, { error: "Invalid unlock request" });
  const body = request.body;
  if (
    typeof body.requestId !== "string" ||
    typeof body.userId !== "number" ||
    !Number.isSafeInteger(body.userId) ||
    body.userId <= 0 ||
    body.requestId !== request.requestId ||
    body.expiresAt !== request.expiresAt ||
    !isEnvelope(body.envelope)
  ) {
    return sendJson(res, 400, { error: "Invalid unlock request" });
  }

  let passphrase: Buffer | null = null;
  try {
    passphrase = decryptPassphrase(body.envelope, keys);
    const fingerprint = await agent.unlock(passphrase);
    sendJson(res, 200, { state: "unlocked", keyId: keys.keyId, fingerprint });
    info("SSH key unlock succeeded");
  } catch {
    sendJson(res, 401, { error: "SSH key unlock failed" });
    info("SSH key unlock failed");
  } finally {
    passphrase?.fill(0);
  }
}

async function buildStatus(agent: AgentController, keyId: string): Promise<HelperStatus> {
  const state = await agent.status();
  return {
    state,
    keyId,
    fingerprint: state === "unlocked" ? await agent.fingerprint() : null,
  };
}

function operationFor(path: string): SignedRequest["operation"] | null {
  if (path === "/public-key") return "public_key";
  if (path === "/status") return "status";
  if (path === "/unlock") return "unlock";
  if (path === "/lock") return "lock";
  return null;
}

function readSignedRequest(
  req: http.IncomingMessage,
  operation: SignedRequest["operation"],
  body: unknown,
): SignedRequest {
  const requestId = header(req, "x-ssh-request-id");
  const expiresAt = Number(header(req, "x-ssh-expires-at"));
  if (
    !requestId ||
    !Number.isSafeInteger(expiresAt) ||
    header(req, "x-ssh-operation") !== operation
  ) {
    throw new Error("Invalid signed request headers");
  }
  return { operation, requestId, expiresAt, body };
}

function header(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (typeof value !== "string") throw new Error(`Missing ${name}`);
  return value;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    req.resume();
    throw new Error("Request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function pruneUsedRequests(usedRequests: Map<string, number>, now: number): void {
  for (const [requestId, expiresAt] of usedRequests) {
    if (expiresAt < now) usedRequests.delete(requestId);
  }
}

function isEnvelope(value: unknown): value is UnlockEnvelope {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.keyId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.nonce === "string" &&
    typeof value.wrappedKey === "string" &&
    typeof value.ciphertext === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function methodNotAllowed(res: http.ServerResponse): void {
  sendJson(res, 405, { error: "Method not allowed" });
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export class HelperHttpServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: HelperConfig,
    private readonly keys: EncryptionKeys,
    private readonly signingPublicKey: KeyObject,
    private readonly agent: AgentController,
  ) {}

  async start(): Promise<void> {
    if (this.server) throw new Error("SSH helper is already running");
    const server = http.createServer(
      createRequestHandler(this.config, this.keys, this.signingPublicKey, this.agent),
    );
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, this.config.bindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
    info(`Listening on ${this.config.bindHost}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, CLOSE_CONNECTIONS_TIMEOUT_MS).unref();
    });
  }
}
