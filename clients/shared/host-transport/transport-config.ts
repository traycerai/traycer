/**
 * Single source of truth for the per-connection WebSocket dial timeout, shared
 * by the unary (`WsRpcClient`) and streaming (`WsStreamClient`) transports
 * across the CLI and the GUI.
 *
 * 10 s (was 5 s, duplicated in five call sites) is deliberately generous: the
 * common cause of a dial timeout is a host that is briefly not yet accepting
 * connections - a cold spawn right after an upgrade, a busy event loop, or a
 * socket frozen across a device sleep. Pairing the longer ceiling with the
 * bounded transport-retry wrapper (`createRetryingMessenger`) absorbs those
 * blips without hanging a user gesture: an unreachable host still surfaces a
 * transport failure within one backoff budget.
 */
export const DEFAULT_DIAL_TIMEOUT_MS = 10_000;

/**
 * The rest of one stream connection's timings, beside the dial timeout for the
 * same reason: main's `browser.sessions` transport and the renderer's durable
 * one must behave identically on the wire, and they used to hold five copied
 * literals each. A drift here is a stream that pings on a different cadence
 * from the one the host closes on.
 */
export const DEFAULT_OPEN_ACK_TIMEOUT_MS = 10_000;
export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_PONG_TIMEOUT_MS = 60_000;
export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
