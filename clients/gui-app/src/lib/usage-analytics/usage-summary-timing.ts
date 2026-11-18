/**
 * Response allowance for host.usage.summary: the server scan has 60 seconds,
 * the host allows 15 more to receive its result, and the GUI leaves another
 * 15 seconds for transport. Keep the operation's 90s allowance separate from
 * ordinary unary calls and from connection/handshake deadlines.
 */
export const USAGE_SUMMARY_RESPONSE_TIMEOUT_MS = 90_000;
