import pino from "pino";
import { config } from "./config.js";

const transportOptions = config.logPretty
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    }
  : undefined;

export const logger = pino(
  {
    level: config.logLevel,
    base: {
      service: "tg-ws-relay",
    },
    formatters: {
      level: (label) => {
        return { level: label.toUpperCase() };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transportOptions ? pino.transport(transportOptions) : undefined,
);

export type Logger = typeof logger;