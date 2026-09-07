import type {
  SelectionAuthorityClient,
  SelectionChange,
  SelectionRevisioned,
  SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type {
  SelectionEvidenceKernel,
  SelectionKernelSnapshot,
} from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { toastSelectionSwitched } from "@/lib/host/selection-switch-toast";
import { appLogger } from "@/lib/logger";
import { notifyEffectiveHostChanged } from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/** Read-only host labelling for the switch toast. */
export interface SelectionHostLabels {
  labelFor(hostId: string): string;
}

export interface SelectionAuthorityBridge {
  dispose(): void;
}

export interface SelectionAuthorityBridgeOptions {
  readonly client: SelectionAuthorityClient;
  /**
   * Already constructed and started by the composition root so transports can report before this bridge mounts.
   */
  readonly kernel: SelectionEvidenceKernel;
  readonly hostLabels: SelectionHostLabels;
}

/**
 * One-way: authority derives `effectiveHostId`, this publishes it.
 * Gestures go through `activate`.
 */
export function mountSelectionAuthorityBridge(
  options: SelectionAuthorityBridgeOptions,
): SelectionAuthorityBridge {
  const kernel = options.kernel;
  /**
   * The newest selection event this bridge has accepted for narration but not yet narrated, because the kernel has not applied that revision here yet.
   * See {@link flushNarration}.
   */
  let pendingNarration: SelectionRevisioned<SelectionChange> | null = null;
  let narratedRevision = -1;

  /** Narration runs only once the window's own state carries the revision being narrated. */
  const flushNarration = (appliedSelectionRevision: number): void => {
    const pending = pendingNarration;
    if (pending === null || pending.revision > appliedSelectionRevision) {
      return;
    }
    pendingNarration = null;
    narrate(pending.change, options.hostLabels);
  };

  const apply = (snapshot: SelectionKernelSnapshot): void => {
    // The store is the ONLY place the derived host lands now.
    // This used to also push the id into the directory via `selectById`, which bound it into `HostClient`'s active slot and fanned out synchronously - the ordering comment that stood here existed to keep a consumer re-rendering off that bind from reading a.
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
    flushNarration(snapshot.selectionRevision);
  };

  const subscriptions: SelectionSubscription[] = [
    kernel.onChange(apply),
    options.client.onSelectionChanged((event) => {
      // Its OWN monotonic high-water, the same rule the kernel applies to its selection slice, so a replayed or reordered event narrates at most once.
      // The raw stream is subscribed at all because the kernel snapshot deliberately carries no `cause`: `resolveCause` is not reconstructible from the tuple (a `fleet-shift` can legally leave `effective !== target`, which a phase-transition guess would mis-report.
      if (event.revision <= narratedRevision) {
        return;
      }
      narratedRevision = event.revision;
      pendingNarration = event;
      flushNarration(kernel.snapshot().selectionRevision);
    }),
  ];

  // The kernel is already started, so its attach may well have settled before this bridge existed - which makes this the line that delivers the opening binding, not a defensive no-op.
  // (While the bridge owned construction it was provably unreachable: every publish path was at least a microtask away from a kernel built and started in the same tick.)
  apply(kernel.snapshot());

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      useSelectionAuthorityStore.getState().reset();
    },
  };
}

function narrate(
  change: SelectionChange,
  hostLabels: SelectionHostLabels,
): void {
  if (change.effectiveHostId === change.previousEffectiveHostId) {
    return;
  }
  appLogger.debug("[selection-bridge] effective host changed", {
    cause: change.cause,
    from: change.previousEffectiveHostId,
    to: change.effectiveHostId,
    targetHostId: change.targetHostId,
  });
  // G4: a `null`-selection surface re-points and resets its host-dependent
  // state. Pinned instances ignore this by construction (D6).
  notifyEffectiveHostChanged(
    change.previousEffectiveHostId,
    change.effectiveHostId,
  );
  // The authority's own verdict, never re-derived here: `recovery` is "landed back on the target", `failover` is "left it".
  // Intent (`HostSelected`) belongs to Settings ▸ Activate and is not fired from a derivation, which is the conflation this split ends.
  const effectiveHostId = change.effectiveHostId;
  if (effectiveHostId !== null) {
    // ∅ has its own narrator - the global modal (D10) - and a toast saying
    // the app switched to nothing would compete with it.
    toastSelectionSwitched({
      cause: change.cause,
      previousEffectiveHostId: change.previousEffectiveHostId,
      hostLabel: hostLabels.labelFor(effectiveHostId),
    });
  }
  if (change.cause === "failover") {
    Analytics.getInstance().track(AnalyticsEvent.HostFailover, null);
    return;
  }
  if (change.cause === "recovery") {
    Analytics.getInstance().track(AnalyticsEvent.HostRecovered, null);
  }
}
