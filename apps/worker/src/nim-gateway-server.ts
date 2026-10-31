import { startNimGateway } from "./nim-gateway.js";

/**
 * Standalone NIM retry gateway.
 *
 * Worker processes can reuse a gateway started by another process. When that
 * owner exits, the shared server would disappear; this entry keeps the gateway
 * independent of any one worker:
 *
 *   node apps/worker/dist/nim-gateway-server.js
 *
 * Bind it to OCC_NIM_GATEWAY_PORT (default 4010). Workers detect the existing
 * health endpoint and reuse it instead of binding.
 */
const gateway = await startNimGateway();
if (!gateway) {
  console.error("OCC_LLM_PROVIDER=deepseek; the NIM gateway is not needed");
  process.exit(0);
}

console.error(JSON.stringify({ event: "nim_gateway_standalone", url: gateway.url }));

const shutdown = async (signal: string): Promise<void> => {
  console.error(JSON.stringify({ event: "nim_gateway_stopping", signal }));
  await gateway.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

// Keep the process (and the HTTP server) alive.
await new Promise<void>(() => {});
