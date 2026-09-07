import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderCliState,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

/** Modelled on the dictation mic's `DictationPreparingStatus` because the UX decision is the same one: the
 * affordance is gated and labelled, never hidden and never offered-then-failed. */
export interface ProviderPackPreparing {
  readonly kind: "downloading" | "error";
  /** 0..100, or null when there is no meaningful progress to show. */
  readonly percent: number | null;
  /** Epoch ms of the next automatic retry, or null when none is scheduled. */
  readonly retryAtMs: number | null;
  /** Why the install is stuck. Null on the `downloading` arm. */
  readonly reason:
    | Extract<ProviderManagedInstallState, { status: "error" }>["reason"]
    | null;
  /** It decides whether this state gates or merely informs, and it is the difference between a pack that is
   * downloading and a provider that cannot run. */
  readonly fallbackRunnable: boolean;
}

/** Does the resolver have anything to spawn for this provider without the managed pack? */
function providerHasRunnableFallback(provider: ProviderCliState): boolean {
  if (provider.availabilityPending) return true;
  return provider.candidates.some((candidate) => candidate.available);
}

/** Takes the whole provider row rather than just `managedInstallState` for exactly that reason. */
export function providerPackPreparingForProvider(
  provider: ProviderCliState,
): ProviderPackPreparing | null {
  const state = provider.managedInstallState;
  if (state === null || state === undefined) return null;
  const fallbackRunnable = providerHasRunnableFallback(provider);
  if (state.status === "downloading") {
    return {
      kind: "downloading",
      percent: state.percent,
      retryAtMs: null,
      reason: null,
      fallbackRunnable,
    };
  }
  if (state.status === "error") {
    return {
      kind: "error",
      percent: null,
      retryAtMs: state.retryAtMs,
      reason: state.reason,
      fallbackRunnable,
    };
  }
  return null;
}

/** Whether this state must disable the affordance, as opposed to only labelling it. */
export function providerPackBlocksExecution(
  preparing: ProviderPackPreparing,
): boolean {
  return !preparing.fallbackRunnable;
}

/** Preparing state per harness id, for the surfaces that hold a provider list (picker rail, composer gates).
 * Providers that are ready simply have no entry, so a `.get` miss is the common, cheap "not gated" answer. */
export function providerPackPreparingByHarnessId(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyMap<GuiHarnessId, ProviderPackPreparing> {
  const entries = new Map<GuiHarnessId, ProviderPackPreparing>();
  for (const provider of providers) {
    const preparing = providerPackPreparingForProvider(provider);
    if (preparing === null) continue;
    entries.set(providerIdToGuiHarnessId(provider.providerId), preparing);
  }
  return entries;
}

/** One function so the picker tooltip, the composer's blocked-submit hint and the terminal launcher cannot
 * drift into three different phrasings of the same state. */
export function providerPackPreparingLabel(
  preparing: ProviderPackPreparing,
  providerLabel: string,
): string {
  if (!providerPackBlocksExecution(preparing)) {
    if (preparing.kind === "error") {
      return `${providerLabel} update failed - ${providerPackErrorDetail(preparing.reason)}`;
    }
    return `Updating ${providerLabel} in background`;
  }
  if (preparing.kind === "error") {
    return `${providerLabel} setup failed - ${providerPackErrorDetail(preparing.reason)}`;
  }
  if (preparing.percent !== null) {
    return `Preparing ${providerLabel}… ${preparing.percent}%`;
  }
  return `Preparing ${providerLabel}…`;
}

export function providerPackPreparingShortLabel(
  preparing: ProviderPackPreparing,
): string {
  if (!providerPackBlocksExecution(preparing)) {
    if (preparing.kind === "error") return "Update failed";
    return "Updating in background";
  }
  if (preparing.kind === "error") return "Setup failed";
  if (preparing.percent !== null) return `Preparing… ${preparing.percent}%`;
  return "Preparing…";
}

/** Other reasons are terminal or require a different transition, so their renderer must not draw an affordance
 * that cannot move them. */
const PROVIDER_PACK_RETRYABLE_REASONS: ReadonlySet<
  NonNullable<ProviderPackPreparing["reason"]>
> = new Set([
  "disk-full",
  "network",
  "verification",
  "live-owner-stalled",
  "unknown",
]);

export function providerPackRetryable(
  preparing: ProviderPackPreparing,
): boolean {
  if (preparing.kind !== "error" || preparing.reason === null) return false;
  return PROVIDER_PACK_RETRYABLE_REASONS.has(preparing.reason);
}

/** Exported for the Settings CLI-candidates section, which is the screen every other surface's recovery copy
 * points a stuck user AT. */
export function providerPackErrorDetail(
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
      // Not a network failure and not the user's to fix: another Traycer process sharing this store owns the
      // download and stopped making progress, so this one stopped waiting behind it.
      return "another Traycer process using this Traycer folder stopped making progress on the download. Retry to pick it up here.";
    case "unrepairable":
      // Re-downloading fetches the byte-identical blob and fails in the same place, fleet-wide, so this copy must
      // not send the user back to an action that cannot work.
      return "this build is defective and reinstalling cannot fix it. A corrected version has to be published - until then, install the CLI yourself and select it in Settings → Providers.";
    case "local-storage-mismatch":
      // An archive that passed its signed digest on arrival read back different, twice, the second time against a
      // freshly downloaded copy.
      return "this device stored the download and read it back changed. Check the disk for errors - until then, install the CLI yourself and select it in Settings → Providers.";
    case "trust-unavailable":
      // What it names now is what exists, and it still never says "retry", because the allow-list deliberately draws
      // no button here.
      return "this device could not verify the provider registry's signing keys, so managed downloads are unavailable here. Traycer re-checks periodically; restarting Traycer checks straight away. A CLI you install yourself keeps working in the meantime.";
    default:
      return "retry to try again.";
  }
}
