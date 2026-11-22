import type { SandboxSummary } from "../sandbox-control";

/**
 * The wire shape of a create the adapter has reported queued, pinned to
 * `SandboxSummary["rateLimit"]` so a drift between this fixture and the
 * protocol type fails compilation rather than a running assertion. Shared
 * by the server's serialization test and the GUI's rendering tests, so both
 * sides exercise the exact same wire value.
 */
export const SANDBOX_RATE_LIMIT_FIXTURE = {
  rateLimit: { limited: true, retryAfterAt: 2_000_000_030_000 },
} satisfies Pick<SandboxSummary, "rateLimit">;
