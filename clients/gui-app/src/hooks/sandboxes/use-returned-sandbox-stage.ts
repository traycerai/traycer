import { useCallback, useEffect, useRef } from "react";
import {
  stageIsReturnedSandbox,
  type ReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import {
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
  const forget = useCallback(
    () =>
      useNewConversationModalStore.getState().setReturnedSandbox(epicId, null),
    [epicId],
  );
  useReturnedSandboxStage(surfaceKey, returned, forget);
}

/** The landing composer: stages its open draft's returned sandbox. */
export function useLandingReturnedSandbox(
  surfaceKey: string,
  draftId: string | null,
): void {
  const returned = useLandingDraftStore((state) =>
    draftId === null
      ? null
      : (state.drafts.find((draft) => draft.id === draftId)?.returnedSandbox ??
        null),
  );
  const forget = useCallback(() => {
    if (draftId !== null)
      useLandingDraftStore.getState().setDraftReturnedSandbox(draftId, null);
  }, [draftId]);
  useReturnedSandboxStage(surfaceKey, returned, forget);
}

/**
 * Puts a draft's returned sandbox back on its composer while the composer
 * holds no stage: after a reload, its Send goes to that sandbox again, with
 * the same create key. A stage of the composer's own always wins. Once the
 * returned stage leaves the composer - sent, or replaced by another pick -
 * the draft forgets it.
 */
function useReturnedSandboxStage(
  surfaceKey: string | null,
  returned: ReturnedSandbox | null,
  forget: () => void,
): void {
  const stage = useStagedSandbox(surfaceKey ?? "");
  const previousRef = useRef<StagedSandbox | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = stage;
    if (surfaceKey === null || returned === null) return;
    const hadReturned = stageIsReturnedSandbox(previous, returned);
    if (hadReturned && !stageIsReturnedSandbox(stage, returned)) {
      forget();
      return;
    }
    if (stage !== null) return;
    const staged = useStagedSandboxStore.getState();
    staged.stage(surfaceKey, returned.target);
    if (returned.clientRequestId !== null)
      staged.report(surfaceKey, { clientRequestId: returned.clientRequestId });
  }, [forget, returned, stage, surfaceKey]);
}
