import { withoutTabRecovery } from "@/lib/tab-recovery/history";
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
import {
  currentDesktopDraftTopology,
  refreshDesktopDraftTopology,
  sameDesktopDraftReference,
  toDesktopLandingDraftReference,
  usesDesktopDraftTopology,
} from "@/lib/windows/desktop-draft-topology";
import type {
  DesktopMoveWindowDraftReferenceRequest,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { isRefGroupedInLayout } from "@/components/layout/hooks/use-epic-open-in-new-window";
import {
  flushCanonicalLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  draftRuntimeRegistry,
  type DraftRuntime,
} from "@/stores/home/draft-runtime-registry";
import {
  drainDesktopTabsPersistence,
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

/**
 * A pasted image reaches the store as a hash roughly a debounce after
 * `putImage` settles, so the barrier is bounded by that plus the write itself,
 * not by anything a user waits on. The cap only exists so a node that never
 * resolves (a store failure whose reclaim already dropped it) cannot wedge the
 * gesture forever.
 */
const INGEST_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Resolve once the draft has no still-ingesting attachment, or `false` when the
 * budget runs out. A draft that has since disappeared counts as settled - the
 * move's own liveness check refuses it a moment later, and that refusal states
 * the real reason.
 */
function whenDraftImagesSettled(
  draftId: string,
  runtime: DraftRuntime | null,
): Promise<boolean> {
  const settled = (): boolean => {
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((candidate) => candidate.id === draftId);
    const content = runtime?.store.getState().content ?? draft?.content;
    return draft === undefined ||
      content === undefined ||
      !draftHasIngestingImages(content);
  };
  if (settled()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const finish = (ready: boolean): void => {
      clearTimeout(timer);
      unsubscribeDraft();
      unsubscribeEditor?.();
      resolve(ready);
    };
    const check = (): void => {
      if (settled()) finish(true);
    };
    const unsubscribeDraft = useLandingDraftStore.subscribe(check);
    const unsubscribeEditor = runtime?.store.subscribe(check);
    const timer = window.setTimeout(() => finish(false), INGEST_SETTLE_TIMEOUT_MS);
  });
}

interface ReferenceMove {
  request: DesktopMoveWindowDraftReferenceRequest | null;
  running: boolean;
}

const referenceMoves = new WeakMap<
  DesktopWindowsBridge,
  Map<string, ReferenceMove>
>();

async function prepareReferenceMove(
  bridge: DesktopWindowsBridge,
  draftId: string,
): Promise<DesktopMoveWindowDraftReferenceRequest | null> {
  const topology = currentDesktopDraftTopology(bridge);
  const source = topology?.references.find((ref) => ref.slotId === draftId);
  const flushTopology = bridge.perWindowState.flushDraftTopology;
  if (
    topology === undefined ||
    source === undefined ||
    flushTopology === undefined
  ) {
    return null;
  }

  const tab: TabRef = { kind: "draft", id: draftId };
  const runtime = draftRuntimeRegistry.getOrHydrate(draftId);
  runtime?.flush();
  if (!(await whenDraftImagesSettled(draftId, runtime))) return null;
  const editorState = runtime?.store.getState();
  const flushed = await flushCanonicalLandingDraft(draftId);
  if (flushed.kind !== "committed") return null;
  const ref = toDesktopLandingDraftReference(flushed.draft);
  if (!sameDesktopDraftReference(ref, source)) return null;

  tabCommandCoordinator.separateBeforeMove(tab);
  await drainDesktopTabsPersistence();
  await flushActiveDesktopPerWindowProjection();
  const moveToken = crypto.randomUUID();
  const handoff = { draftId, moveToken };
  try {
    await stageDraftImageHandoff(handoff, flushed.manifest.digests);
    const ready = await flushTopology.call(bridge.perWindowState, ref);
    if (
      ready.result === "ready" &&
      ready.revision === topology.revision &&
      !isTabStructurallyLocked(tab) &&
      !isRefGroupedInLayout(tab) &&
      runtime?.store.getState() === editorState
    ) {
      return { moveToken, ref, expectedSourceTopologyRevision: ready.revision };
    }
  } catch (error) {
    await discardDraftImageHandoff(handoff);
    throw error;
  }
  await discardDraftImageHandoff(handoff);
  return null;
}

async function moveDraftReference(
  bridge: DesktopWindowsBridge,
  draftId: string,
): Promise<boolean> {
  const invoke = bridge.moveDraftReference?.bind(bridge);
  if (invoke === undefined) return false;
  let moves = referenceMoves.get(bridge);
  if (moves === undefined) {
    moves = new Map();
    referenceMoves.set(bridge, moves);
  }
  const move = moves.get(draftId) ?? { request: null, running: false };
  if (move.running) return false;
  moves.set(draftId, move);
  move.running = true;
  try {
    move.request ??= await prepareReferenceMove(bridge, draftId);
    if (move.request === null) return false;
    const request = move.request;
    // Resolve a lost reply with the original intent, even if the source view
    // has since received the committed move's topology event.
    const result = await invoke(request).catch(() => invoke(request));
    move.request = null;
    if (result.result !== "moved") {
      await discardDraftImageHandoff({ draftId, moveToken: request.moveToken });
      return false;
    }
    if (result.destinationLoadFailed === true) {
      await bridge.requestFocus(result.destinationWindowId);
    }
    await refreshDesktopDraftTopology(bridge);
    const current = currentDesktopDraftTopology(bridge);
    return (
      current !== undefined &&
      current.revision >= result.sourceTopologyRevision &&
      !current.references.some((ref) => ref.slotId === draftId)
    );
  } finally {
    move.running = false;
    if (move.request === null) moves.delete(draftId);
  }
}

export function useDraftOpenInNewWindowFlow(
  bridge: DesktopWindowsBridge | null,
): DraftNewWindowFlow {
  const navigate = useNavigate();
  const router = useRouter();

  const requestOpenInNewWindow = useCallback(
    (request: DraftNewWindowRequest) => {
      // Bound at the probe: the capability check and the eventual call must
      // name the same function, and binding keeps the bridge's `this`.
      if (bridge === null) return;
      const draftId = request.draftId;
      if (usesDesktopDraftTopology(bridge)) {
        void moveDraftReference(bridge, draftId)
          .then((removed) => {
            if (
              removed &&
              router.state.location.pathname === draftPathname(draftId)
            ) {
              void navigate(LANDING_ROUTE);
            }
          })
          .catch((error: unknown) => {
            appLogger.warn("[windows] draft reference move failed", {
              draftId,
              error: describeLogError(error),
            });
          });
        return;
      }
      const requestMove = bridge.requestOpenDraftInNewWindow?.bind(bridge);
      if (requestMove === undefined) return;
      const ref: TabRef = { kind: "draft", id: draftId };
      // Set the instant the move is confirmed, so the failure handler can tell
      // "the bytes are still ours to clean up" from "the destination owns them
      // now" - a throw AFTER the move (the local close, a navigation) must not
      // delete a handoff the new window has not adopted yet.
      let moveConfirmed = false;
      void (async () => {
        // Step 1: drain the live editor's debounced writer so the content the
        // projection carries includes the last keystrokes.
        draftRuntimeRegistry.flush(draftId);
        // Step 2: wait out any attachment still ingesting. Before the tab is
        // separated, so a barrier that times out leaves the strip untouched.
        if (!(await whenDraftImagesSettled(draftId, null))) return;
        // Step 3: a grouped draft cannot be handed over still paired -
        // separate first, and let step 5's revalidation catch a refused
        // separation, exactly as the epic move does.
        tabCommandCoordinator.separateBeforeMove(ref);
        // Step 4: the durability barriers. Tab-strip separation first, then
        // the per-window projection (which carries the draft's content) so the
        // main process's source snapshot is current when the IPC reads it.
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
        // Stage bytes BEFORE the IPC: the destination adopts on its first
        // projection, which can run the moment the window exists.
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
        // Step 7: remove the local copy. The coordinator routes the removal
        // through the same source mutation an ordinary close uses (layout
        // entry + draft record + runtime teardown + image GC), with its echo
        // suppression around it. Active-ness is read NOW, not captured before
        // the awaits: the user may have navigated elsewhere mid-flow, and
        // yanking them back to the landing page over a stale capture is worse
        // than leaving them where they are.
        const wasActive =
          router.state.location.pathname === draftPathname(draftId);
        withoutTabRecovery(() =>
          tabCommandCoordinator.closeRefAfterConfirmed(ref),
        );
        if (wasActive) {
          void navigate(LANDING_ROUTE);
        }
      })().catch((error: unknown) => {
        appLogger.warn("[windows] open draft in new window failed", {
          draftId,
          error: describeLogError(error),
        });
        // The refusal returns above each clean up their own staging; a THROW
        // is the one path that would otherwise strand the staged bytes in a
        // handoff DB no window will ever adopt or delete.
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
