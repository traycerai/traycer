import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import {
  captureDraftAuthorityActor,
  draftAuthorityOptionalActorIsCurrent,
} from "@/lib/drafts/draft-authority-session";
import { appLogger, describeLogError } from "@/lib/logger";
import { captureHeaderLocation } from "@/lib/tab-recovery/header-layout";
import {
  recoveryHistoryGeneration,
  type ClosedHeaderTab,
} from "@/lib/tab-recovery/history";
import {
  currentDesktopDraftTopology,
  refreshDesktopDraftTopology,
  sameDesktopDraftReference,
  toDesktopLandingDraftReference,
  usesDesktopDraftTopology,
} from "@/lib/windows/desktop-draft-topology";
import type {
  DesktopWindowsBridge,
  DesktopWindowDraftReferenceEdit,
  DesktopWindowDraftTopology,
} from "@/lib/windows/types";
import {
  captureCanonicalLandingDraft,
  flushCanonicalLandingDraft,
  readCanonicalLandingDraft,
  retainCanonicalLandingHistoryDraft,
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
  readonly historyIsCurrent: () => boolean;
}

export function observeDesktopDraftClose(
  bridge: DesktopWindowsBridge | null,
): DesktopDraftCloseObservation | null {
  if (bridge === null || !usesDesktopDraftTopology(bridge)) return null;
  const actor = captureDraftAuthorityActor();
  const generation = recoveryHistoryGeneration();
  return {
    bridge,
    topology: currentDesktopDraftTopology(bridge),
    historyIsCurrent: () =>
      generation === recoveryHistoryGeneration() &&
      draftAuthorityOptionalActorIsCurrent(actor),
  };
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
      appLogger.warn("[windows] draft reference close failed", {
        error: describeLogError(error),
      });
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
  const { bridge, topology, historyIsCurrent } = observation;
  const perWindowState = bridge.perWindowState;
  const update = perWindowState.updateDraftReferences?.bind(perWindowState);
  const empty = { closed: new Set<string>(), recoveries: [] };
  if (topology === undefined || update === undefined) return empty;
  const stillCurrent = (): boolean =>
    historyIsCurrent() &&
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
      const isCurrent = (): boolean => stillCurrent() && !isTabCloseLocked(tab);
      if (!isCurrent()) return null;
      const read = await readCanonicalLandingDraft(flushed.draft);
      if (
        read.kind !== "live" || read.draft.version !== flushed.draft.version ||
        !isCurrent()
      ) return null;
      const draft = read.payload;
      const recovery: ClosedHeaderTab | null =
        !isEmptyLandingDraftContent(draft.content)
          ? {
              kind: "draft",
              draftId: draft.id,
              draftReference: {
                slotId: ref.slotId,
                occurrence: ref.occurrenceId,
              },
              hostId: draft.adoption.state === "adopted" ? draft.adoption.hostId : null,
              ...captureHeaderLocation(layout, tab, 0),
            }
          : null;
      if (recovery !== null) {
        const retained = await retainCanonicalLandingHistoryDraft({
          draft: flushed.draft,
          isCurrent,
        });
        if (retained.kind !== "retained" || !isCurrent()) return null;
      }
      return { ref, tab, draft: flushed.draft, recovery };
    })()];
  }));
  const eligible = prepared.filter((entry) => entry !== null).filter((entry) => {
    if (isTabCloseLocked(entry.tab)) return false;
    const current = captureCanonicalLandingDraft(entry.ref.slotId);
    return current?.occurrence === entry.draft.occurrence &&
      current.version === entry.draft.version;
  });
  if (eligible.length === 0 || !stillCurrent()) return empty;
  const result = await update({
    expectedTopologyRevision: topology.revision,
    edits: eligible.map<DesktopWindowDraftReferenceEdit>(({ ref }) => ({
      kind: "detach",
      ref,
    })),
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
    recoveries: historyIsCurrent()
      ? committed.flatMap(({ recovery }) => recovery === null ? [] : [recovery])
      : [],
  };
}
