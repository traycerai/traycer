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
