import type { ProviderManagedInstallErrorReason } from "@traycer/protocol/host/provider-schemas";

/**
 * Whether a failed provider pack install may be OFFERED a retry, as opposed to
 * only described: the GUI's retry affordance and the CLI's automatic retry in
 * `traycer profile login` both ask here.
 *
 * The five allow-listed reasons are genuine "try again" cases: a
 * user-initiated `providers.ensurePack` clears the pack's backoff and jumps
 * the queue. Other reasons are terminal or require a different transition, so
 * their caller must not offer a retry that cannot move them.
 * `unrepairable`, for example, means the local copy verified against its
 * signed digest and was defective anyway; the host has recorded the cell as
 * terminal and refuses further installs for it. The failure is still
 * described, with why it happened; it is only never offered-then-failed.
 *
 * An ALLOW-LIST, not an exclusion. An exclusion silently treats every newly
 * known reason as retryable. `trust-unavailable` demonstrates why that is
 * unsafe: the host has no install machinery at all, so a retry button would
 * reach `providers.ensurePack` and be offered-then-failed. Adding a reason
 * now requires deciding whether a click can move it.
 *
 * The current non-retryable reasons cover a defective published build, a host
 * that cannot verify its keyring, and a device whose storage keeps corrupting
 * a verified archive. The allow-list makes the policy durable as that closed
 * vocabulary grows.
 */
const PROVIDER_PACK_RETRYABLE_REASONS: ReadonlySet<ProviderManagedInstallErrorReason> =
  new Set([
    "disk-full",
    "network",
    "verification",
    "live-owner-stalled",
    "unknown",
  ]);

export function providerPackReasonRetryable(
  reason: ProviderManagedInstallErrorReason,
): boolean {
  return PROVIDER_PACK_RETRYABLE_REASONS.has(reason);
}
