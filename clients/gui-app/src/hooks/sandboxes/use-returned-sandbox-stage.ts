import { useCallback, useEffect, useRef } from "react";
import {
  onReturnedSandboxSuperseded,
  sameReturnedSandbox,
  stageIsReturnedSandbox,
  type ReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import {
  readStagedSandbox,
  useStagedSandbox,
  useStagedSandboxStore,
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

/**
 * The task's new-agent composer, unnamed: stages its draft's returned
 * sandbox. A modal that names its host (`hostId`) stages nothing.
 */
export function useNewConversationReturnedSandbox(
  epicId: string,
  hostId: string | null,
): void {
  const surfaceKey = hostId === null ? newConversationSurfaceKey(epicId) : null;
  const returned = useNewConversationModalStore(
    (state) => state.draftPatchesByEpicId[epicId]?.returnedSandbox ?? null,
  );
  const read = useCallback(
    () =>
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
        ?.returnedSandbox ?? null,
    [epicId],
  );
  const forget = useCallback(
    () =>
      useNewConversationModalStore.getState().setReturnedSandbox(epicId, null),
    [epicId],
  );
  useReturnedSandboxStage(surfaceKey, returned, read, forget);
}

/**
 * The landing composer: stages its open draft's returned sandbox. Only the
 * `active` one acts: retained drafts share the window's surface.
 */
export function useLandingReturnedSandbox(
  surfaceKey: string,
  draftId: string | null,
  active: boolean,
): void {
  const returned = useLandingDraftStore((state) =>
    draftId === null
      ? null
      : (state.drafts.find((draft) => draft.id === draftId)?.returnedSandbox ??
        null),
  );
  const read = useCallback(
    () =>
      draftId === null
        ? null
        : (useLandingDraftStore
            .getState()
            .drafts.find((draft) => draft.id === draftId)?.returnedSandbox ??
          null),
    [draftId],
  );
  const forget = useCallback(() => {
    if (draftId !== null)
      useLandingDraftStore.getState().setDraftReturnedSandbox(draftId, null);
  }, [draftId]);
  useReturnedSandboxStage(active ? surfaceKey : null, returned, read, forget);
}

/**
 * Puts a draft's returned sandbox back on its composer once, when the draft
 * is shown (opened, or after a reload) and the composer holds no stage: its
 * Send goes to that sandbox again, with the same create key. A stage of the
 * composer's own always wins. Any pick in the composer's picker forgets the
 * returned sandbox, and so does its stage leaving the composer (sent, or
 * replaced). `surfaceKey` is null while the composer is inactive.
 */
function useReturnedSandboxStage(
  surfaceKey: string | null,
  returned: ReturnedSandbox | null,
  read: () => ReturnedSandbox | null,
  forget: () => void,
): void {
  useEffect(() => {
    if (surfaceKey === null) return;
    return onReturnedSandboxSuperseded(surfaceKey, forget);
  }, [forget, surfaceKey]);

  useEffect(() => {
    if (surfaceKey === null || returned === null) return;
    // The live stores, not this render's: another composer or a pick may
    // have moved since.
    if (
      readStagedSandbox(surfaceKey) !== null ||
      !sameReturnedSandbox(read(), returned)
    )
      return;
    const staged = useStagedSandboxStore.getState();
    staged.stage(surfaceKey, returned.target);
    if (returned.clientRequestId !== null)
      staged.report(surfaceKey, { clientRequestId: returned.clientRequestId });
  }, [read, returned, surfaceKey]);

  const stage = useStagedSandbox(surfaceKey ?? "");
  const previousRef = useRef<StagedSandbox | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = stage;
    if (surfaceKey === null || returned === null) return;
    if (
      stageIsReturnedSandbox(previous, returned) &&
      !stageIsReturnedSandbox(stage, returned)
    )
      forget();
  }, [forget, returned, stage, surfaceKey]);
}
