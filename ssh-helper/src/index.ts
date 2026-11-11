import { createAgentController } from "./agent.js";
import { loadConfig } from "./config.js";
import { loadEncryptionKeys, loadSigningPublicKey } from "./crypto.js";
import { HelperHttpServer } from "./http-server.js";
import { error } from "./logger.js";

const config = loadConfig();
const keys = loadEncryptionKeys(config);
const signingPublicKey = loadSigningPublicKey(config);
const agent = createAgentController(config);
const server = new HelperHttpServer(config, keys, signingPublicKey, agent);

const shutdown = (): void => {
  void server.stop().finally(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.start().catch((cause) => {
  error("Could not start", cause);
  process.exitCode = 1;
});
