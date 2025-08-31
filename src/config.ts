import { config as loadEnv } from "dotenv";

loadEnv();

export interface Config {
  port: number;
  allowedOrigins: string[];
  token: string | undefined;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  logPretty: boolean;
  clientIdleTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  pingIntervalMs: number;
  maxBufferedBytes: number;
  allowedUpstreamHostPatterns: RegExp[];
}

function parseLogLevel(level: string | undefined): Config["logLevel"] {
  const validLevels = ["trace", "debug", "info", "warn", "error"] as const;
  const normalized = level?.toLowerCase() as Config["logLevel"];
  if (validLevels.includes(normalized)) {
    return normalized;
  }
  return "debug";
}

function parseHostPatterns(csv: string | undefined): RegExp[] {
  if (!csv || csv.trim() === "") {
    // No defaults - must be explicitly configured
    return [];
  }
  
  return csv.split(",").map(pattern => {
    const trimmed = pattern.trim();
    if (!trimmed) return null;
    
    // Convert wildcard patterns to regex
    // Replace * with .* and escape other special regex characters
    const regexPattern = trimmed
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
      .replace(/\*/g, '.*'); // Convert * to .*
    
    try {
      return new RegExp(`^${regexPattern}$`, 'i'); // Case-insensitive
    } catch (error) {
      throw new Error(`Invalid host pattern "${trimmed}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }).filter((p): p is RegExp => p !== null);
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number value: ${value}`);
  }
  return parsed;
}

function parseOrigins(csv: string | undefined): string[] {
  if (!csv || csv.trim() === "") return [];
  return csv.split(",").map(origin => origin.trim()).filter(Boolean);
}

export const config: Config = {
  port: parseNumber(process.env.PORT, 8080),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
  token: process.env.TOKEN || undefined,
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  logPretty: process.env.LOG_PRETTY === "true",
  clientIdleTimeoutMs: parseNumber(process.env.CLIENT_IDLE_TIMEOUT_MS, 120000),
  upstreamIdleTimeoutMs: parseNumber(process.env.UPSTREAM_IDLE_TIMEOUT_MS, 120000),
  pingIntervalMs: parseNumber(process.env.PING_INTERVAL_MS, 25000),
  maxBufferedBytes: parseNumber(process.env.MAX_BUFFERED_BYTES, 5_000_000),
  allowedUpstreamHostPatterns: parseHostPatterns(process.env.ALLOWED_UPSTREAM_HOSTS),
};

if (config.port < 1 || config.port > 65535) {
  throw new Error(`Invalid PORT: ${config.port}`);
}

if (config.clientIdleTimeoutMs < 1000) {
  throw new Error(`CLIENT_IDLE_TIMEOUT_MS too low: ${config.clientIdleTimeoutMs}`);
}

if (config.upstreamIdleTimeoutMs < 1000) {
  throw new Error(`UPSTREAM_IDLE_TIMEOUT_MS too low: ${config.upstreamIdleTimeoutMs}`);
}

if (config.pingIntervalMs < 1000) {
  throw new Error(`PING_INTERVAL_MS too low: ${config.pingIntervalMs}`);
}

if (config.maxBufferedBytes < 1024) {
  throw new Error(`MAX_BUFFERED_BYTES too low: ${config.maxBufferedBytes}`);
}