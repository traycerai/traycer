import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderCliState,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

/**
 * A provider whose managed (registry-backed) binary pack is not ready to run
 * yet. Modelled on the dictation mic's `DictationPreparingStatus` because the
 * UX decision is the same one: the affordance is GATED and labelled, never
 * hidden and never offered-then-failed.
 *
 * `percent` is 0..100 while bytes are moving and null when there is no
 * progress to report - a queued pack has seen no bytes, and a pack whose
 * download a live sibling host owns is genuinely in progress with no
 * observable byte count. A null percent means an indeterminate indicator, not
 * a zero.
 */
export interface ProviderPackPreparing {
  readonly kind: "downloading" | "error";
  /** 0..100, or null when there is no meaningful progress to show. */
  readonly percent: number | null;
  /** Epoch ms of the next automatic retry, or null when none is scheduled. */
  readonly retryAtMs: number | null;
  /** Why the install is stuck. Null on the `downloading` arm. */
  readonly reason:
    Extract<ProviderManagedInstallState, { status: "error" }>["reason"] | null;
}

/**
 * The single mapping from wire state to "is this provider gated".
 *
 * `null` (an old host, an unmanaged store, or a provider the staged rollout
 * has not cut over) and `installed` and `absent` all mean NOT GATED, and the
 * three for genuinely different reasons that happen to share an answer:
 *
 * - `null`/`absent` - this host has no managed-pack opinion about the
 *   provider, so the existing `available`-flag rendering on the bundled
 *   candidate stays authoritative, exactly as it did before the registry. A
 *   provider still shipping bundled bytes runs fine with `absent`; gating on
 *   it would break every provider on every pre-cutover host.
 * - `installed` - the pack is present and verified.
 *
 * Only `downloading` and `error` gate. The host resolver remains the
 * authoritative backstop either way (it throws a typed `preparing` outcome);
 * this is UX, so it fails OPEN - an unrecognized future arm leaves the
 * affordance enabled and lets the host have the final word, rather than
 * locking a user out of a provider the host would happily spawn.
 */
export function providerPackPreparingFromInstallState(
  state: ProviderManagedInstallState | null | undefined,
): ProviderPackPreparing | null {
  if (state === null || state === undefined) return null;
  if (state.status === "downloading") {
    return {
      kind: "downloading",
      percent: state.percent,
      retryAtMs: null,
      reason: null,
    };
  }
  if (state.status === "error") {
    return {
      kind: "error",
      percent: null,
      retryAtMs: state.retryAtMs,
      reason: state.reason,
    };
  }
  return null;
}

/**
 * Preparing state per harness id, for the surfaces that hold a provider list
 * (picker rail, composer gates). Providers that are ready simply have no
 * entry, so a `.get()` miss is the common, cheap "not gated" answer.
 */
export function providerPackPreparingByHarnessId(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyMap<GuiHarnessId, ProviderPackPreparing> {
  const entries = new Map<GuiHarnessId, ProviderPackPreparing>();
  for (const provider of providers) {
    const preparing = providerPackPreparingFromInstallState(
      provider.managedInstallState,
    );
    if (preparing === null) continue;
    entries.set(providerIdToGuiHarnessId(provider.providerId), preparing);
  }
  return entries;
}

/**
 * The label every gated surface shows. One function so the picker tooltip,
 * the composer's blocked-submit hint and the terminal launcher cannot drift
 * into three different phrasings of the same state.
 *
 * Deliberately mirrors the dictation mic's `preparingLabel`: a percentage when
 * one is known, an honest indeterminate phrase when it is not, and a distinct
 * line for the failed case so a stuck install never reads as a slow one.
 */
export function providerPackPreparingLabel(
  preparing: ProviderPackPreparing,
  providerLabel: string,
): string {
  if (preparing.kind === "error") {
    return `${providerLabel} setup failed - ${providerPackErrorDetail(preparing.reason)}`;
  }
  if (preparing.percent !== null) {
    return `Preparing ${providerLabel}… ${preparing.percent}%`;
  }
  return `Preparing ${providerLabel}…`;
}

/** Short copy for the picker rail, where there is no room for a full sentence. */
export function providerPackPreparingShortLabel(
  preparing: ProviderPackPreparing,
): string {
  if (preparing.kind === "error") return "Setup failed";
  if (preparing.percent !== null) return `Preparing… ${preparing.percent}%`;
  return "Preparing…";
}

/**
 * Whether a failed pack's surface may OFFER a retry, as opposed to only
 * describing the failure.
 *
 * Every reason but `unrepairable` is a genuine "try again": a user-initiated
 * `providers.ensurePack` clears the pack's backoff and jumps the queue.
 * `unrepairable` means the local copy verified against its signed digest and
 * was defective anyway, so the host has recorded the cell as TERMINAL and
 * refuses further installs for it - the click cannot do anything, now or later,
 * and `providerManagedInstallErrorReasonSchema`'s own contract is that a
 * renderer must not draw the affordance. Withholding it is the same
 * "gated and labelled, never offered-then-failed" rule the rest of this module
 * follows, applied one level in: the tab is still labelled with why it failed.
 *
 * An ALLOW-LIST, not an exclusion. The exclusion form was sound only while
 * `unrepairable` was the single non-retryable member, and its own justification
 * - unknown members normalize to null, so everything reaching here is known -
 * is exactly what makes it dangerous now: a KNOWN new member is retryable by
 * default, silently. `trust-unavailable` proved it. That reason means the host
 * has no install machinery at all, so the exclusion form would have drawn a
 * retry button whose click reaches `providers.ensurePack` on a host that
 * cannot serve it - offered-then-failed, the precise thing this module exists
 * to prevent, reintroduced by a one-line vocabulary addition.
 *
 * The set now has two non-retryable members for two unrelated causes (a
 * defective published build; a host that cannot verify its keyring), which is
 * the point at which "list what is allowed" stops being ceremony. Adding a
 * reason now requires deciding whether a click can move it.
 */
const PROVIDER_PACK_RETRYABLE_REASONS: ReadonlySet<
  NonNullable<ProviderPackPreparing["reason"]>
> = new Set(["disk-full", "network", "verification", "live-owner-stalled", "unknown"]);

export function providerPackRetryable(
  preparing: ProviderPackPreparing,
): boolean {
  if (preparing.kind !== "error" || preparing.reason === null) return false;
  return PROVIDER_PACK_RETRYABLE_REASONS.has(preparing.reason);
}

function providerPackErrorDetail(
  reason: ProviderPackPreparing["reason"],
): string {
  switch (reason) {
    case "disk-full":
      return "not enough disk space. Free some space, then retry.";
    case "network":
      return "the download could not be reached. Retry when you're back online.";
    case "verification":
      return "the downloaded files failed verification. Retry to fetch them again.";
    case "live-owner-stalled":
      // Not a network failure and not the user's to fix: another Traycer
      // process on this machine owns the download and stopped making progress,
      // so this one stopped waiting behind it. Naming the sibling is the whole
      // value of the reason - "check your connection" would send the user after
      // something that is working fine. The copy offers the retry (this IS a
      // retryable reason, with a real `retryAtMs`) without promising a moment:
      // the backoff makes an automatic attempt eligible again, it does not
      // schedule one.
      return "another Traycer process on this device stopped making progress on the download. Retry to pick it up here.";
    case "unrepairable":
      // The one terminal reason. Re-downloading fetches the byte-identical
      // blob and fails in the same place, fleet-wide, so this copy must not
      // send the user back to an action that cannot work - it names the one
      // thing that can (a new release) and the one move they own (a PATH or
      // custom install they point Traycer at).
      return "this build is defective and reinstalling cannot fix it. A corrected version has to be published - until then, install the CLI yourself and select it in Settings → Providers.";
    case "trust-unavailable":
      // Not about this pack, and not something a retry can move: the host
      // could not verify the registry's keyring, so it has no install
      // machinery at all. The copy names the two things that DO clear it - the
      // connection coming back (the host re-attempts on its own) and a
      // restart - and deliberately never says "retry", because the affordance
      // is withheld for exactly this reason.
      return "this device could not verify the provider registry. It will try again once you're back online; restarting Traycer also retries immediately.";
    default:
      return "retry to try again.";
  }
}
