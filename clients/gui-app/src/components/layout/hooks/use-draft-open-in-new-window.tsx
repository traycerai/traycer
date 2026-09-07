import { useCallback, useMemo } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { LANDING_ROUTE, draftPathname } from "@/lib/routes";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  discardDraftImageHandoff,
  draftHasIngestingImages,
  draftImageHashes,
  stageDraftImageHandoff,
} from "@/lib/composer/landing-image-move";
import { flushActiveDesktopPerWindowProjection } from "@/lib/windows/per-window-projection-debounce";
import type { DesktopWindowsBridge } from "@/lib/windows/types";
import { isRefGroupedInLayout } from "@/components/layout/hooks/use-epic-open-in-new-window";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import {
  flushDesktopTabsPersistence,
  hasPendingDesktopTabsWrite,
} from "@/stores/tabs/desktop-tabs-persistence";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { isTabStructurallyLocked } from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

export interface DraftNewWindowRequest {
  readonly draftId: string;
}

export interface DraftNewWindowFlow {
  readonly requestOpenInNewWindow: (request: DraftNewWindowRequest) => void;
}

/** The cap only exists so a node that never resolves (a store failure whose reclaim already dropped it) cannot
 * wedge the gesture forever. */
const INGEST_SETTLE_TIMEOUT_MS = 5_000;

/** Resolve once the draft has no still-ingesting attachment, or `false` when the budget runs out. */
function whenDraftImagesSettled(draftId: string): Promise<boolean> {
  const settled = (): boolean => {
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((candidate) => candidate.id === draftId);
    return draft === undefined || !draftHasIngestingImages(draft.content);
  };
  if (settled()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let unsubscribe = (): void => undefined;
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, INGEST_SETTLE_TIMEOUT_MS);
    unsubscribe = useLandingDraftStore.subscribe(() => {
      if (!settled()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/** `requestOpenDraftInNewWindow` is capability-probed: an older desktop shell without the IPC silently no-ops,
 * the same degradation contract as `perWindowState.clear`. */
export function useDraftOpenInNewWindowFlow(
  bridge: DesktopWindowsBridge | null,
): DraftNewWindowFlow {
  const navigate = useNavigate();
  const router = useRouter();

  const requestOpenInNewWindow = useCallback(
    (request: DraftNewWindowRequest) => {
      // Bound at the probe: the capability check and the eventual call must
      // name the same function, and binding keeps the bridge's `this`.
      const requestMove = bridge?.requestOpenDraftInNewWindow?.bind(bridge);
      if (bridge === null || requestMove === undefined) return;
      const draftId = request.draftId;
      const ref: TabRef = { kind: "draft", id: draftId };
      // Set the instant the move is confirmed, so the failure handler can tell "the bytes are still ours to clean
      // up" from "the destination owns them now".
      let moveConfirmed = false;
      void (async () => {
        // Step 1: drain the live editor's debounced writer so the content the
        // projection carries includes the last keystrokes.
        draftRuntimeRegistry.flush(draftId);
        // Step 2: wait out any attachment still ingesting. Before the tab is
        // separated, so a barrier that times out leaves the strip untouched.
        if (!(await whenDraftImagesSettled(draftId))) return;
        // Step 3: a grouped draft cannot be handed over still paired - separate first, and let step 5's revalidation
        // catch a refused separation, exactly as the epic move does.
        tabCommandCoordinator.separateBeforeMove(ref);
        // Step 4: the durability barriers.
        if (hasPendingDesktopTabsWrite()) {
          const flushed = await flushDesktopTabsPersistence().then(
            () => true,
            () => false,
          );
          if (!flushed) return;
        }
        const draft = useLandingDraftStore
          .getState()
          .drafts.find((candidate) => candidate.id === draftId);
        if (draft === undefined) return;
        // Stage bytes before the IPC: the destination adopts on its first projection, which can run the moment the
        // window exists.
        const hashes = draftImageHashes(draft.content);
        await stageDraftImageHandoff(draftId, hashes);
        const projected = await flushActiveDesktopPerWindowProjection().then(
          () => true,
          () => false,
        );
        if (!projected) {
          await discardDraftImageHandoff(draftId);
          return;
        }
        // Step 5: revalidate after the awaits - still open, unlocked,
        // ungrouped.
        const live = useLandingDraftStore
          .getState()
          .drafts.some((candidate) => candidate.id === draftId);
        if (
          !live ||
          isTabStructurallyLocked(ref) ||
          isRefGroupedInLayout(ref)
        ) {
          await discardDraftImageHandoff(draftId);
          return;
        }
        // Step 6: the move IPC.
        const result = await requestMove(draftId);
        if (result.result !== "moved") {
          await discardDraftImageHandoff(draftId);
          return;
        }
        moveConfirmed = true;
        // Active-ness is read now, not captured before the awaits: the user may have navigated elsewhere mid-flow, and
        // yanking them back to the landing page over a stale capture is worse than leaving them where they are.
        const wasActive =
          router.state.location.pathname === draftPathname(draftId);
        tabCommandCoordinator.closeRefAfterConfirmed(ref);
        if (wasActive) {
          void navigate(LANDING_ROUTE);
        }
      })().catch((error: unknown) => {
        appLogger.warn("[windows] open draft in new window failed", {
          draftId,
          error: describeLogError(error),
        });
        // The refusal returns above each clean up their own staging; a throw is the one path that would otherwise
        // strand the staged bytes in a handoff DB no window will ever adopt or delete.
        if (moveConfirmed) return;
        void discardDraftImageHandoff(draftId).catch(
          (cleanupError: unknown) => {
            appLogger.warn("[windows] draft-move handoff cleanup failed", {
              draftId,
              error: describeLogError(cleanupError),
            });
          },
        );
      });
    },
    [bridge, navigate, router],
  );

  return useMemo(() => ({ requestOpenInNewWindow }), [requestOpenInNewWindow]);
}
