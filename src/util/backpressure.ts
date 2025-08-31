import type WebSocket from "ws";
import type { Logger } from "../logger.js";
import { config } from "../config.js";

export interface BackpressureState {
  isPaused: boolean;
  totalBytes: number;
}

export function checkBackpressure(
  ws: WebSocket,
  state: BackpressureState,
  opposite: WebSocket,
  log: Logger,
  direction: "downstream" | "upstream",
): void {
  const buffered = ws.bufferedAmount;
  
  if (buffered > config.maxBufferedBytes && !state.isPaused) {
    state.isPaused = true;
    opposite.pause();
    log.warn(
      { 
        direction, 
        bufferedBytes: buffered, 
        threshold: config.maxBufferedBytes 
      },
      "Backpressure threshold exceeded, pausing opposite stream",
    );
  }
}

export function handleDrain(
  ws: WebSocket,
  state: BackpressureState,
  opposite: WebSocket,
  log: Logger,
  direction: "downstream" | "upstream",
): void {
  const buffered = ws.bufferedAmount;
  
  if (state.isPaused && buffered < config.maxBufferedBytes * 0.5) {
    state.isPaused = false;
    opposite.resume();
    log.info(
      { 
        direction, 
        bufferedBytes: buffered, 
        threshold: config.maxBufferedBytes 
      },
      "Backpressure relieved, resuming opposite stream",
    );
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}