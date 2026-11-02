import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { OpencodeLine } from "@traycer/protocol/common/opencode-line";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderManagedLine,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { providerPackReasonRetryable } from "@traycer-clients/shared/providers/provider-pack-retry";
import {
  guiHarnessIdToProviderId,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import { isOpencodeFamilyHarness } from "@/lib/chat/opencode-line";

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
    | Extract<ProviderManagedInstallState, { status: "error" }>["reason"]
    | null;
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

function selectedExternalCandidate(
  provider: ProviderCliState,
): ProviderCliCandidate | undefined {
  const selected = provider.selected;
  if (selected.kind === "bundled") return undefined;
  return provider.candidates.find((candidate) =>
    selected.kind === "path"
      ? candidate.kind === "path"
      : candidate.kind === "custom" && candidate.path === selected.path,
  );
}

function candidateOpencodeLine(
  candidate: ProviderCliCandidate,
): OpencodeLine | null {
  if (!candidate.available || candidate.versionPending) return null;
  const major = candidate.version?.match(
    /^v?([12])\.\d+\.\d+(?:[-+].*)?$/,
  )?.[1];
  if (major === "1") return 1;
  if (major === "2") return 2;
  return null;
}

/**
 * Mirrors the host's `resolveNewChatOpencodeLine` in
 * `domain/providers/opencode-line-default.ts`: the destination's saved
 * OpenCode selection names every sibling's line, and plain Managed means 2
 * for this client. A pending or unknown external version proves no line.
 * Sandbox creates carry this result so launch uses the line readiness checked.
 */
export function newChatOpencodeLineFromProviders(
  providers: ReadonlyArray<ProviderCliState>,
): OpencodeLine | null {
  const provider = providers.find((row) => row.providerId === "opencode");
  if (provider === undefined || provider.availabilityPending) return null;
  if (provider.selected.kind === "bundled") return provider.selected.line ?? 2;
  const candidate = selectedExternalCandidate(provider);
  if (candidate?.versionPending) return null;
  if (candidate === undefined || !candidate.available) return 2;
  return candidateOpencodeLine(candidate);
}

/**
 * Positive launch proof for sandbox sends. OpenCode-family callers require
 * OpenCode's per-line pack state, and missing state means keep preparing.
 * The host's `opencode-binary-guard.ts`
 * `resolveOpencodeLine1Launch` (99-151) reads each sibling's own external
 * selection; `resolveOpencodeLine2SiblingLaunch` (207-220) forces Managed 2.
 * OpenCode's external selection chooses a sibling's new-chat line but cannot
 * prove that sibling's engine runnable. Never use the legacy line-1 pack.
 */
export function providerPackPreparingForSandboxAgent(
  harnessId: GuiHarnessId,
  providers: ReadonlyArray<ProviderCliState>,
  opencodeLine: OpencodeLine | null,
): ProviderPackPreparing | null {
  const providerId = guiHarnessIdToProviderId(harnessId);
  const provider = providers.find((row) => row.providerId === providerId);
  if (!isOpencodeFamilyHarness(harnessId))
    return sandboxProviderPackPreparing(provider);
  const engine = providers.find((row) => row.providerId === "opencode");
  const externalProvider =
    harnessId === "opencode" || opencodeLine === 1 ? provider : undefined;
  if (
    opencodeLine === null ||
    engine?.availabilityPending ||
    externalProvider?.availabilityPending
  )
    return SANDBOX_AGENT_WAITING;
  return sandboxOpencodePackPreparing(engine, externalProvider, opencodeLine);
}

/**
 * Ordinary CLI harnesses prove their executable in their own availability
 * probe (for example ClaudeAdapter.isAvailable). A candidate's version is
 * display metadata, not launch proof; its probe may time out indefinitely.
 * Older hosts and unmanaged providers also have no managed-pack state. Keep
 * explicit setup blockers unless a runnable candidate supplies the fallback,
 * then let the caller require the harness's settled availability.
 */
function sandboxProviderPackPreparing(
  provider: ProviderCliState | undefined,
): ProviderPackPreparing | null {
  if (provider === undefined) return null;
  if (provider.availabilityPending) return SANDBOX_AGENT_WAITING;
  const preparing = providerPackPreparingForProvider(provider);
  return preparing !== null && providerPackBlocksExecution(preparing)
    ? preparing
    : null;
}

const SANDBOX_AGENT_WAITING: ProviderPackPreparing = {
  kind: "downloading",
  percent: null,
  retryAtMs: null,
  reason: null,
  fallbackRunnable: false,
};

/** Managed line proof and external-version proof must describe the same engine. */
function sandboxOpencodePackPreparing(
  provider: ProviderCliState | undefined,
  externalProvider: ProviderCliState | undefined,
  opencodeLine: OpencodeLine,
): ProviderPackPreparing | null {
  const external =
    externalProvider === undefined
      ? undefined
      : selectedExternalCandidate(externalProvider);
  if (external?.versionPending) return SANDBOX_AGENT_WAITING;
  if (external?.available) {
    const externalLine = candidateOpencodeLine(external);
    if (externalLine === null) return SANDBOX_AGENT_WAITING;
    if (externalLine === opencodeLine) return null;
    // Only line 1 substitutes Managed 1 for an external v2. The line-2
    // engine refuses a selected external v1 instead of falling back.
    if (opencodeLine === 2) return SANDBOX_AGENT_WAITING;
  }
  const managedLine = provider?.managedLines?.find(
    (entry) => entry.line === opencodeLine,
  );
  return sandboxManagedLinePreparing(managedLine);
}

/** The managed pack and its own candidate must both prove launch readiness. */
function sandboxManagedLinePreparing(
  managedLine: ProviderManagedLine | undefined,
): ProviderPackPreparing | null {
  if (managedLine?.candidate.versionPending) return SANDBOX_AGENT_WAITING;
  if (
    managedLine?.managedInstallState?.status === "installed" &&
    !managedLine.candidate.available
  )
    return SANDBOX_AGENT_WAITING;
  return sandboxPackPreparingFromState(managedLine?.managedInstallState);
}

/** Missing managed OpenCode line proof is waiting, never successful setup. */
function sandboxPackPreparingFromState(
  state: ProviderManagedInstallState | null | undefined,
): ProviderPackPreparing | null {
  if (state?.status === "installed") return null;
  if (state?.status === "error") {
    return {
      kind: "error",
      percent: null,
      retryAtMs: state.retryAtMs,
      reason: state.reason,
      fallbackRunnable: false,
    };
  }
  return state?.status === "downloading"
    ? { ...SANDBOX_AGENT_WAITING, percent: state.percent }
    : SANDBOX_AGENT_WAITING;
}

/**
 * Does the resolver have anything to spawn for this provider without the
 * managed pack? Mirrors `resolveProviderCli`'s own precedence (custom →
 * managed → PATH → bundled): it only reports `preparing` when EVERY tier
 * missed, so a client that gates on the managed tier alone is stricter than
 * the host it is speaking for.
 *
 * The legacy pack-status projection below counts `availabilityPending` as
 * runnable. Sandbox sends use positive launch proof above. The pending flag
 * means the shell-env PATH probe has not settled, so `candidates` under-reports; the EXECUTE path
 * awaits that same probe before it decides, which means a PATH binary this
 * list has not seen yet is one the host would happily spawn. Gating on the
 * unsettled snapshot would dim a working provider for a poll tick; not gating
 * costs at worst one bounced turn on a host that has nothing, and the host's
 * typed `preparing` error is the backstop for exactly that.
 *
 * (An earlier note here described the closure-coupled carve as a narrow
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

function selectedExternalCandidateRunnable(
  provider: ProviderCliState,
): boolean {
  const selected = provider.selected;
  if (selected.kind === "bundled") return false;
  // A PATH probe that has not settled cannot yet rule out the selected binary.
  if (selected.kind === "path" && provider.availabilityPending) return true;
  return provider.candidates.some(
    (candidate) =>
      candidate.available &&
      (selected.kind === "path"
        ? candidate.kind === "path"
        : candidate.kind === "custom" && candidate.path === selected.path),
  );
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
 * OpenCode's managed fallbacks use that line's state and candidate; the
 * legacy provider-level candidate describes line 1 and cannot make line 2
 * runnable. Line 1 retains its PATH fallback; line 2 runs from its managed
 * pack. A runnable external selection keeps precedence; a missing one falls
 * back to the managed line.
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
  const managedLine =
    provider.providerId === "opencode" &&
    provider.managedLines !== undefined &&
    !selectedExternalCandidateRunnable(provider)
      ? provider.managedLines.find(
          (entry) =>
            entry.line ===
            (provider.selected.kind === "bundled"
              ? (provider.selected.line ?? 2)
              : 2),
        )
      : undefined;
  const state =
    managedLine === undefined
      ? provider.managedInstallState
      : managedLine.managedInstallState;
  if (state === null || state === undefined) return null;
  const fallbackRunnable =
    managedLine === undefined
      ? providerHasRunnableFallback(provider)
      : managedLine.candidate.available ||
        (managedLine.line === 1 &&
          (provider.availabilityPending ||
            provider.candidates.some(
              (candidate) => candidate.kind === "path" && candidate.available,
            )));
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
 * A bound chat keeps its own OpenCode line even when the new-chat selection
 * changes. Other surfaces pass `null` to follow the provider selection.
 */
export function providerPackPreparingByHarnessId(
  providers: ReadonlyArray<ProviderCliState>,
  opencodeLine: OpencodeLine | null,
): ReadonlyMap<GuiHarnessId, ProviderPackPreparing> {
  const entries = new Map<GuiHarnessId, ProviderPackPreparing>();
  for (const provider of providers) {
    const preparing = providerPackPreparingForProvider(
      provider.providerId === "opencode" &&
        provider.managedLines !== undefined &&
        opencodeLine !== null &&
        !selectedExternalCandidateRunnable(provider)
        ? { ...provider, selected: { kind: "bundled", line: opencodeLine } }
        : provider,
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
 * describing the failure. The allow-list and its reasoning live with
 * `providerPackReasonRetryable` in `clients/shared`, which the CLI reads too.
 */
export function providerPackRetryable(
  preparing: ProviderPackPreparing,
): boolean {
  if (preparing.kind !== "error" || preparing.reason === null) return false;
  return providerPackReasonRetryable(preparing.reason);
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
