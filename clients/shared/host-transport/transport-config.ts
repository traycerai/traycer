/**
 * Single source of truth for the per-connection WebSocket dial timeout, shared by the unary (`WsRpcClient`) and streaming (`WsStreamClient`) transports across the CLI and the gui.
 */
export const DEFAULT_DIAL_TIMEOUT_MS = 10_000;

export const DEFAULT_OPEN_ACK_TIMEOUT_MS = 10_000;
export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_PONG_TIMEOUT_MS = 60_000;
export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
