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
  /**
   * True when the host would still SPAWN something for this provider right
   * now - a bundled, PATH-discovered or custom candidate reporting
   * `available`. It decides whether this state GATES or merely INFORMS, and it
   * is the difference between a pack that is downloading and a provider that
   * cannot run: those are not the same fact, and reading the second off the
   * first is what dimmed every provider on a host with perfectly good bundled
   * bytes.
   */
  readonly fallbackRunnable: boolean;
}

/**
 * Does the resolver have anything to spawn for this provider without the
 * managed pack? Mirrors `resolveProviderCli`'s own precedence (custom →
 * managed → PATH → bundled): it only reports `preparing` when EVERY tier
 * missed, so a client that gates on the managed tier alone is stricter than
 * the host it is speaking for.
 *
 * `availabilityPending` counts as runnable, and that is the fail-open reading
 * this module has taken everywhere else. The pending flag means the shell-env
 * PATH probe has not settled, so `candidates` under-reports; the EXECUTE path
 * awaits that same probe before it decides, which means a PATH binary this
 * list has not seen yet is one the host would happily spawn. Gating on the
 * unsettled snapshot would dim a working provider for a poll tick; not gating
 * costs at worst one bounced turn on a host that has nothing, and the host's
 * typed `preparing` error is the backstop for exactly that.
 *
 * (An earlier note here described the D6 closure-coupled carve as a narrow
 * over-openness - a PATH candidate the host would refuse while this reports
 * `available`. The carve was removed host-side on 2026-08-19: auto-PATH now
 * serves closure packs like every other provider, so an `available` PATH
 * candidate is one the host will actually spawn and the over-openness no
 * longer exists.)
 */
function providerHasRunnableFallback(provider: ProviderCliState): boolean {
  if (provider.availabilityPending) return true;
  return provider.candidates.some((candidate) => candidate.available);
}

/**
 * The single mapping from a provider row to "is there a managed-pack state
 * worth saying anything about".
 *
 * `null` (an old host, an unmanaged store, or a provider the staged rollout
 * has not cut over) and `installed` and `absent` all mean NOTHING TO REPORT,
 * and the three for genuinely different reasons that happen to share an
 * answer:
 *
 * - `null`/`absent` - this host has no managed-pack opinion about the
 *   provider, so the existing `available`-flag rendering on the bundled
 *   candidate stays authoritative, exactly as it did before the registry. A
 *   provider still shipping bundled bytes runs fine with `absent`; gating on
 *   it would break every provider on every pre-cutover host.
 * - `installed` - the pack is present and verified.
 *
 * Only `downloading` and `error` produce a state, and producing one is NOT the
 * same as gating - `providerPackBlocksExecution` owns that question and reads
 * `fallbackRunnable`. Takes the whole provider row rather than just
 * `managedInstallState` for exactly that reason: the row is the only place the
 * fallback candidates live, and a caller holding the state alone cannot answer
 * the question that matters.
 *
 * The host resolver remains the authoritative backstop throughout (it throws a
 * typed `preparing` outcome); this is UX, so it fails OPEN - an unrecognized
 * future arm leaves the affordance enabled and lets the host have the final
 * word, rather than locking a user out of a provider the host would happily
 * spawn.
 */
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

/**
 * Whether this state must DISABLE the affordance, as opposed to only labelling
 * it. The one predicate every gating surface asks, so the composer, the picker
 * rail, the terminal launcher and the Sign-in button cannot disagree about
 * what "preparing" costs the user.
 *
 * A pack that is downloading while a runnable binary sits on disk blocks
 * nothing: the host resolves the fallback and the turn runs. Only a provider
 * with nowhere to fall back to is genuinely unavailable, which is the case the
 * whole gated-and-labelled design was built for.
 */
export function providerPackBlocksExecution(
  preparing: ProviderPackPreparing,
): boolean {
  return !preparing.fallbackRunnable;
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
    const preparing = providerPackPreparingForProvider(provider);
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
 *
 * A NON-BLOCKING state gets its own voice rather than a softened version of
 * the blocking one. "Claude Code setup failed" in front of a user whose Claude
 * Code is running fine from PATH is simply false, and "Preparing…" on a
 * provider they can use right now reads as a wait they do not have. The
 * fallback label describes the managed copy's update, not the provider's
 * readiness: that is the one subject the status cell owns.
 */
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

/** Short copy for the picker rail, where there is no room for a full sentence. */
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

/**
 * Whether a failed pack's surface may OFFER a retry, as opposed to only
 * describing the failure.
 *
 * The five allow-listed reasons are genuine "try again" cases: a
 * user-initiated `providers.ensurePack` clears the pack's backoff and jumps
 * the queue. Other reasons are terminal or require a different transition, so
 * their renderer must not draw an affordance that cannot move them.
 * `unrepairable`, for example, means the local copy verified against its
 * signed digest and was defective anyway; the host has recorded the cell as
 * terminal and refuses further installs for it. Withholding the retry is the
 * same "gated and labelled, never offered-then-failed" rule the rest of this
 * module follows, applied one level in: the tab is still labelled with why it
 * failed.
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

/**
 * Exported for the Settings CLI-candidates section, which is the screen every
 * other surface's recovery copy points a stuck user AT. The rail and the
 * composer have room for a phrase, so they take the assembled labels above;
 * Settings has room for the sentence, and until now it showed the shortest
 * string in this module - a bare "Setup failed" - on the one screen where the
 * reason was the entire point of arriving.
 */
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
      // Not a network failure and not the user's to fix: another Traycer
      // process sharing this store owns the download and stopped making
      // progress, so this one stopped waiting behind it. Naming the sibling is
      // the whole value of the reason - "check your connection" would send the
      // user after something that is working fine. The copy offers the retry
      // (this IS a retryable reason, with a real `retryAtMs`) without promising
      // a moment: the backoff makes an automatic attempt eligible again, it
      // does not schedule one.
      //
      // "using this Traycer folder", not "on this device". The lease record
      // carries pid and process-start identity and NO machine identity, so
      // nothing here knows where the sibling runs - and in the one topology
      // that makes this reason common (a `~/.traycer` shared across machines)
      // "on this device" is flatly false. See the host's matching arm and
      // docs/provider-pack-store-support-boundary.md.
      return "another Traycer process using this Traycer folder stopped making progress on the download. Retry to pick it up here.";
    case "unrepairable":
      // The one terminal reason. Re-downloading fetches the byte-identical
      // blob and fails in the same place, fleet-wide, so this copy must not
      // send the user back to an action that cannot work - it names the one
      // thing that can (a new release) and the one move they own (a PATH or
      // custom install they point Traycer at).
      return "this build is defective and reinstalling cannot fix it. A corrected version has to be published - until then, install the CLI yourself and select it in Settings → Providers.";
    case "local-storage-mismatch":
      // The third non-retryable reason, and the only one that is about the
      // user's machine rather than about Traycer. An archive that passed its
      // signed digest on arrival read back different, twice, the second time
      // against a freshly downloaded copy - so the host has stopped refetching
      // and this copy must not offer the click that would resume it. Named as
      // a disk problem because that is the only thing the user can act on.
      return "this device stored the download and read it back changed. Check the disk for errors - until then, install the CLI yourself and select it in Settings → Providers.";
    case "trust-unavailable":
      // Not about this pack, and not something a retry can move: the host
      // could not verify the registry's keyring, so it has no install
      // machinery at all. The copy names the two things that DO clear it - the
      // connection coming back (the host re-attempts on its own) and a
      // restart - and deliberately never says "retry", because the affordance
      // is withheld for exactly this reason.
      //
      // This used to end "It will try again once you're back online". No
      // connectivity listener exists anywhere in the host - not in the
      // keyring loader, not in the install manager, not in the runtime. The
      // real triggers are the periodic reconvergence tick and a restart, so
      // the sentence promised a mechanism nothing implements, in the commit
      // written to remove exactly that. Worse operationally than cosmetically:
      // the rollout's stage-0 abort criterion is "any trust-unavailable that
      // does not clear on its own", and an operator who believes clearance
      // arrives at reconnect aborts a healthy rollout when it takes the tick.
      //
      // What it names now is what exists, and it still never says "retry",
      // because the allow-list deliberately draws no button here.
      return "this device could not verify the provider registry's signing keys, so managed downloads are unavailable here. Traycer re-checks periodically; restarting Traycer checks straight away. A CLI you install yourself keeps working in the meantime.";
    default:
      return "retry to try again.";
  }
}
