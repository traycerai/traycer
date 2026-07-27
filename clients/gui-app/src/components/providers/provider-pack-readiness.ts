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
  readonly reason: Extract<
    ProviderManagedInstallState,
    { status: "error" }
  >["reason"] | null;
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
    default:
      return "retry to try again.";
  }
}
