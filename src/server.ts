import { createServer, IncomingMessage } from "http";
import { URL } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { connectUpstream } from "./upstream/connect.js";
import { 
  checkBackpressure, 
  handleDrain, 
  formatBytes,
  type BackpressureState 
} from "./util/backpressure.js";

interface ConnectionStats {
  bytesDownstreamToUpstream: number;
  bytesUpstreamToDownstream: number;
  connectedAt: Date;
  connId: string;
}

function generateConnId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function validateOrigin(origin: string | undefined): boolean {
  if (config.allowedOrigins.length === 0) {
    return true;
  }
  if (!origin) {
    return false;
  }
  return config.allowedOrigins.includes(origin);
}

function validateToken(providedToken: string | undefined): boolean {
  if (!config.token) {
    return true;
  }
  return providedToken === config.token;
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocketServer({
  server,
  path: "/apiws",
  perMessageDeflate: false,
  handleProtocols: (_protocols, _request) => {
    return "binary";
  },
});

wss.on("connection", (downstream: WebSocket, request: IncomingMessage) => {
  const connId = generateConnId();
  const stats: ConnectionStats = {
    bytesDownstreamToUpstream: 0,
    bytesUpstreamToDownstream: 0,
    connectedAt: new Date(),
    connId,
  };
  
  const clientIp = request.socket.remoteAddress || "unknown";
  const origin = request.headers.origin;
  const userAgent = request.headers["user-agent"];
  
  const log = logger.child({ connId });
  
  log.info({
    clientIp,
    origin,
    userAgent: userAgent ? "present" : "absent",
    path: request.url,
    protocol: downstream.protocol,
    readyState: downstream.readyState,
  }, "Incoming WebSocket connection");
  
  try {
    const url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
    const params = url.searchParams;
    
    const upstreamParam = params.get("upstream");
    if (!upstreamParam) {
      log.warn("Missing upstream URL parameter");
      downstream.close(4002, "Missing upstream URL");
      return;
    }
    
    let upstreamUrl: string;
    try {
      upstreamUrl = decodeURIComponent(upstreamParam);
      const parsedUrl = new URL(upstreamUrl);
      
      // Validate protocol
      if (parsedUrl.protocol !== "wss:" && parsedUrl.protocol !== "ws:") {
        log.warn({ protocol: parsedUrl.protocol }, "Invalid upstream protocol");
        downstream.close(4003, "Invalid upstream protocol");
        return;
      }
      
      // Validate against allowed host patterns
      if (config.allowedUpstreamHostPatterns.length > 0) {
        const isAllowed = config.allowedUpstreamHostPatterns.some(pattern => 
          pattern.test(parsedUrl.hostname)
        );
        if (!isAllowed) {
          log.warn({ hostname: parsedUrl.hostname }, "Upstream host not allowed");
          downstream.close(4004, "Upstream host not allowed");
          return;
        }
      } else {
        // No patterns configured - reject all
        log.warn({ hostname: parsedUrl.hostname }, "No upstream host patterns configured");
        downstream.close(4004, "No upstream host patterns configured");
        return;
      }
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, "Invalid upstream URL");
      downstream.close(4002, "Invalid upstream URL");
      return;
    }
    
    const token = params.get("token") || undefined;
    
    if (!validateOrigin(origin)) {
      log.warn({ origin }, "Origin validation failed");
      downstream.close(4000, "Origin not allowed");
      return;
    }
    log.debug({ origin }, "Origin validation passed");
    
    if (!validateToken(token)) {
      log.warn("Token validation failed");
      downstream.close(4001, "Invalid or missing token");
      return;
    }
    if (config.token) {
      log.debug("Token validation passed");
    }
    
    log.info({ upstreamUrl }, "Establishing upstream connection");
    
    const upstream = connectUpstream(upstreamUrl, log);
    
    let downstreamIdleTimer: NodeJS.Timeout | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let downstreamAlive = true;
    let closed = false;
    
    // Buffer for messages received before upstream is ready
    const pendingMessages: Buffer[] = [];
    
    const downstreamBackpressure: BackpressureState = {
      isPaused: false,
      totalBytes: 0,
    };
    
    const upstreamBackpressure: BackpressureState = {
      isPaused: false,
      totalBytes: 0,
    };
    
    const resetDownstreamIdleTimer = () => {
      if (downstreamIdleTimer) {
        clearTimeout(downstreamIdleTimer);
      }
      downstreamIdleTimer = setTimeout(() => {
        log.warn("Downstream idle timeout reached, closing connection");
        cleanup(1000, "Idle timeout");
      }, config.clientIdleTimeoutMs);
    };
    
    const cleanup = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      
      const duration = Date.now() - stats.connectedAt.getTime();
      
      log.info({
        code,
        reason,
        durationMs: duration,
        bytesDown2Up: formatBytes(stats.bytesDownstreamToUpstream),
        bytesUp2Down: formatBytes(stats.bytesUpstreamToDownstream),
        totalBytes: formatBytes(stats.bytesDownstreamToUpstream + stats.bytesUpstreamToDownstream),
      }, "Connection closed");
      
      if (downstreamIdleTimer) {
        clearTimeout(downstreamIdleTimer);
        downstreamIdleTimer = null;
      }
      
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      
      // Use 1000 (normal closure) if code is invalid for sending
      const safeCode = (code === 1005 || code === 1006) ? 1000 : code;
      
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close(safeCode, reason);
      } else {
        downstream.terminate();
      }
      
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close(safeCode, reason);
      } else {
        upstream.terminate();
      }
    };
    
    resetDownstreamIdleTimer();
    
    pingTimer = setInterval(() => {
      if (!downstreamAlive) {
        log.warn("Downstream ping timeout, terminating connection");
        cleanup(1000, "Ping timeout");
        return;
      }
      
      downstreamAlive = false;
      downstream.ping();
      log.trace("Sent ping to downstream");
    }, config.pingIntervalMs);
    
    downstream.on("message", (data, isBinary) => {
      if (!isBinary) {
        log.warn("Received non-binary message from downstream, ignoring");
        return;
      }
      
      const bytes = Buffer.isBuffer(data) ? data.length : (data as ArrayBuffer).byteLength;
      stats.bytesDownstreamToUpstream += bytes;
      log.debug({ bytes, isBinary }, "Received message from downstream");
      
      resetDownstreamIdleTimer();
      
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: true }, (error) => {
          if (error) {
            log.error({ error: error.message }, "Error sending to upstream");
          } else {
            log.trace({ bytes }, "Sent message to upstream");
          }
        });
        checkBackpressure(upstream, upstreamBackpressure, downstream, log, "upstream");
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        // Buffer the message until upstream is ready
        log.debug({ bytes }, "Buffering message until upstream is ready");
        pendingMessages.push(data as Buffer);
      } else {
        log.warn({ readyState: upstream.readyState }, "Upstream closed/closing, dropping message");
      }
    });
    
    downstream.on("pong", () => {
      log.trace("Received pong from downstream");
      downstreamAlive = true;
      resetDownstreamIdleTimer();
    });
    
    downstream.on("ping", () => {
      log.trace("Received ping from downstream");
      resetDownstreamIdleTimer();
    });
    
    downstream.on("close", (code, reason) => {
      log.info({ code, reason: reason?.toString() || "unknown" }, "Downstream closed");
      cleanup(code, reason?.toString() || "Downstream closed");
    });
    
    downstream.on("error", (error) => {
      log.error({ error: error.message }, "Downstream error");
      cleanup(1011, "Downstream error");
    });
    
    upstream.on("open", () => {
      log.info({ upstreamUrl }, "Upstream connected successfully");
      
      // Flush any buffered messages
      if (pendingMessages.length > 0) {
        log.info({ count: pendingMessages.length }, "Flushing buffered messages to upstream");
        for (const message of pendingMessages) {
          upstream.send(message, { binary: true }, (error) => {
            if (error) {
              log.error({ error: error.message }, "Error sending buffered message to upstream");
            } else {
              log.trace({ bytes: message.length }, "Sent buffered message to upstream");
            }
          });
        }
        pendingMessages.length = 0; // Clear the buffer
      }
    });
    
    upstream.on("message", (data, isBinary) => {
      if (!isBinary) {
        log.warn("Received non-binary message from upstream, ignoring");
        return;
      }
      
      const bytes = Buffer.isBuffer(data) ? data.length : (data as ArrayBuffer).byteLength;
      stats.bytesUpstreamToDownstream += bytes;
      log.debug({ bytes, isBinary }, "Received message from upstream");
      
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: true }, (error) => {
          if (error) {
            log.error({ error: error.message }, "Error sending to downstream");
          } else {
            log.trace({ bytes }, "Sent message to downstream");
          }
        });
        checkBackpressure(downstream, downstreamBackpressure, upstream, log, "downstream");
      } else {
        log.warn({ readyState: downstream.readyState }, "Downstream not open, dropping message");
      }
    });
    
    upstream.on("close", (code, reason) => {
      log.info({ code, reason: reason?.toString() || "unknown" }, "Upstream closed");
      cleanup(code, reason?.toString() || "Upstream closed");
    });
    
    upstream.on("error", (error) => {
      log.error({ error: error.message }, "Upstream error");
      cleanup(1011, "Upstream error");
    });
    
    downstream.on("drain", () => {
      handleDrain(downstream, downstreamBackpressure, upstream, log, "downstream");
    });
    
    upstream.on("drain", () => {
      handleDrain(upstream, upstreamBackpressure, downstream, log, "upstream");
    });
    
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, "Connection handling error");
    downstream.close(1011, "Internal server error");
  }
});

const PORT = config.port;

server.listen(PORT, () => {
  logger.info({ port: PORT, config: {
    allowedOrigins: config.allowedOrigins.length > 0 ? config.allowedOrigins : "all",
    tokenRequired: !!config.token,
    logLevel: config.logLevel,
    clientIdleTimeoutMs: config.clientIdleTimeoutMs,
    upstreamIdleTimeoutMs: config.upstreamIdleTimeoutMs,
    pingIntervalMs: config.pingIntervalMs,
    maxBufferedBytes: formatBytes(config.maxBufferedBytes),
  }}, "WebSocket relay server started");
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down gracefully");
  
  wss.clients.forEach((client) => {
    client.close(1000, "Server shutting down");
  });
  
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down gracefully");
  
  wss.clients.forEach((client) => {
    client.close(1000, "Server shutting down");
  });
  
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});