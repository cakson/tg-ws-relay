import WebSocket from "ws";
import type { Logger } from "../logger.js";
import { config } from "../config.js";

export function connectUpstream(url: string, log: Logger): WebSocket {
  log.debug({ url }, "Connecting to upstream");

  const upstream = new WebSocket(url, ["binary"], {
    handshakeTimeout: 10000,
    perMessageDeflate: false,
  });

  let idleTimer: NodeJS.Timeout | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      log.warn("Upstream idle timeout reached, closing connection");
      upstream.terminate();
    }, config.upstreamIdleTimeoutMs);
  };

  upstream.on("open", () => {
    log.info({ 
      url, 
      protocol: upstream.protocol,
      readyState: upstream.readyState 
    }, "Upstream connection opened");
    resetIdleTimer();
  });

  upstream.on("message", (data, isBinary) => {
    const bytes = Buffer.isBuffer(data) ? data.length : (data as ArrayBuffer).byteLength;
    log.trace(
      { bytes, isBinary },
      "Received message from upstream",
    );
    resetIdleTimer();
  });

  upstream.on("ping", () => {
    log.trace("Received ping from upstream");
    resetIdleTimer();
  });

  upstream.on("pong", () => {
    log.trace("Received pong from upstream");
    resetIdleTimer();
  });

  upstream.on("close", (code, reason) => {
    log.info(
      { code, reason: reason?.toString() || "unknown" },
      "Upstream connection closed",
    );
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  });

  upstream.on("error", (error) => {
    log.error({ error: error.message }, "Upstream connection error");
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  });

  upstream.on("unexpected-response", (_req, res) => {
    log.error(
      { statusCode: res.statusCode, statusMessage: res.statusMessage },
      "Unexpected response from upstream",
    );
  });

  return upstream;
}