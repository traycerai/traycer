import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import { appLogger } from "@/lib/logger";
import { captureHeaderLocation } from "@/lib/tab-recovery/header-layout";
import type { ClosedHeaderTab } from "@/lib/tab-recovery/history";
import {
  currentDesktopDraftTopology,
  refreshDesktopDraftTopology,
  sameDesktopDraftReference,
  toDesktopLandingDraftReference,
  usesDesktopDraftTopology,
} from "@/lib/windows/desktop-draft-topology";
import type {
  DesktopWindowsBridge,
  DesktopWindowDraftTopology,
} from "@/lib/windows/types";
import {
  flushCanonicalLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import type { PersistedTabStripLayout } from "@/stores/tabs/layout";
import { isTabCloseLocked } from "@/stores/tabs/tab-structural-lock";
import { tabRequestClose } from "@/stores/tabs/registry";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";

function closeTabRef(ref: TabRef): void {
  tabCommandCoordinator.closeRefAfterConfirmed(ref);
}

/**
 * The kind decides whether to close; the coordinator performs it. Handed in
 * here rather than imported by each kind, because the coordinator imports the
 * registry that imports every kind.
 */
export function requestTabClose(tab: HeaderTab): void {
  tabRequestClose(tab, closeTabRef);
}

/**
 * Pure dispatch: route a `HeaderTab` close to the per-kind descriptor.
 * No UI, no routing, no neighbor pick. The orchestrator
 * (`useCloseTabFlow`) wraps this with the unsynced-edits gate and
 * post-close focus restoration. The returned function is
 * module-stable, so callers can pass it to effect/callback dep arrays
 * without churn.
 */
export function useTabCloseCommand(): (tab: HeaderTab) => void {
  return requestTabClose;
}

export interface DesktopDraftCloseObservation {
  readonly bridge: DesktopWindowsBridge;
  readonly topology: DesktopWindowDraftTopology | undefined;
}

export function observeDesktopDraftClose(
  bridge: DesktopWindowsBridge | null,
): DesktopDraftCloseObservation | null {
  if (bridge === null || !usesDesktopDraftTopology(bridge)) return null;
  return { bridge, topology: currentDesktopDraftTopology(bridge) };
}

export function withDesktopDraftReferencesClosed(
  observation: DesktopDraftCloseObservation | null,
  tabs: readonly HeaderTab[],
  layout: PersistedTabStripLayout,
  finish: (
    closed: readonly HeaderTab[],
    recoveries: readonly ClosedHeaderTab[],
  ) => void,
): void {
  if (observation === null || tabs.every((tab) => tab.kind !== "draft")) {
    finish(tabs, []);
    return;
  }
  const otherTabs = tabs.filter((tab) => tab.kind !== "draft");
  void detachDesktopDraftReferences(observation, tabs, layout).then(
    ({ closed, recoveries }) => {
      finish(tabs.filter((tab) => tab.kind !== "draft" || closed.has(tab.id)), recoveries);
    },
    (error: unknown) => {
      appLogger.warn("[windows] draft reference close failed", { error });
      finish(otherTabs, []);
    },
  );
}

interface DetachedDraftReferences {
  readonly closed: ReadonlySet<string>;
  readonly recoveries: readonly ClosedHeaderTab[];
}

async function detachDesktopDraftReferences(
  observation: DesktopDraftCloseObservation,
  tabs: readonly HeaderTab[],
  layout: PersistedTabStripLayout,
): Promise<DetachedDraftReferences> {
  const { bridge, topology } = observation;
  const update = bridge.perWindowState.updateDraftReferences;
  const empty = { closed: new Set<string>(), recoveries: [] };
  if (topology === undefined || update === undefined) return empty;
  const stillCurrent = (): boolean =>
    currentDesktopDraftTopology(bridge)?.revision === topology.revision;
  if (!stillCurrent()) return empty;

  const prepared = await Promise.all(topology.references.flatMap((ref) => {
    const tab = tabs.find((entry) => entry.kind === "draft" && entry.id === ref.slotId);
    if (tab === undefined || isTabCloseLocked(tab)) return [];
    return [(async () => {
      const flushed = await flushCanonicalLandingDraft(ref.slotId);
      if (
        flushed.kind !== "committed" ||
        !sameDesktopDraftReference(ref, toDesktopLandingDraftReference(flushed.draft)) ||
        isTabCloseLocked(tab)
      ) {
        return null;
      }
      const draft = useLandingDraftStore.getState().drafts.find(
        (entry) => entry.id === ref.slotId,
      );
      const recovery: ClosedHeaderTab | null =
        draft !== undefined && !isEmptyLandingDraftContent(draft.content)
          ? {
              kind: "draft",
              draftId: draft.id,
              hostId: draft.adoption.state === "adopted" ? draft.adoption.hostId : null,
              ...captureHeaderLocation(layout, tab, 0),
            }
          : null;
      return { ref, recovery };
    })()];
  }));
  const eligible = prepared.filter((entry) => entry !== null);
  if (eligible.length === 0 || !stillCurrent()) return empty;
  const result = await update.call(bridge.perWindowState, {
    expectedTopologyRevision: topology.revision,
    edits: eligible.map(({ ref }) => ({ kind: "detach", ref })),
    activeDraftId: eligible.some(({ ref }) => ref.slotId === topology.activeDraftId)
      ? null
      : topology.activeDraftId,
  });
  if (result.result !== "committed") return empty;

  await refreshDesktopDraftTopology(bridge);
  const latest = currentDesktopDraftTopology(bridge);
  if (latest === undefined || latest.revision < result.revision) return empty;
  const committed = eligible.filter(({ ref }) =>
    !latest.references.some((current) => current.slotId === ref.slotId),
  );
  return {
    closed: new Set(committed.map(({ ref }) => ref.slotId)),
    recoveries: committed.flatMap(({ recovery }) => recovery === null ? [] : [recovery]),
  };
}
