import { useCallback, useEffect, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  markReturnedSandboxRestored,
  onReturnedSandboxSuperseded,
  returnedSandboxFor,
  sameReturnedSandbox,
  sameStoredReturnedSandbox,
  stageIsReturnedSandbox,
  takeReturnedSandboxRestored,
  type StoredReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  readStagedSandbox,
  useStagedSandbox,
  useStagedSandboxStore,
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

function signedInUserId(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}

function taskReturnedSandbox(
  epicId: string,
  userId: string | null,
): StoredReturnedSandbox | null {
  return returnedSandboxFor(
    useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
      ?.returnedSandbox ?? null,
    userId,
  );
}

/**
 * The task's new-agent composer, unnamed: stages its draft's returned
 * sandbox. A modal that names its host (`hostId`) stages nothing. Answers
 * whether the draft holds one: that is where its Send goes.
 */
export function useNewConversationReturnedSandbox(
  epicId: string,
  hostId: string | null,
): boolean {
  const surfaceKey = hostId === null ? newConversationSurfaceKey(epicId) : null;
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const returned = useStoreWithEqualityFn(
    useNewConversationModalStore,
    (state) =>
      returnedSandboxFor(
        state.draftPatchesByEpicId[epicId]?.returnedSandbox ?? null,
        userId,
      ),
    sameStoredReturnedSandbox,
  );
  const read = useCallback(
    () => taskReturnedSandbox(epicId, signedInUserId()),
    [epicId],
  );
  const forget = useCallback(
    () =>
      useNewConversationModalStore.getState().setReturnedSandbox(epicId, null),
    [epicId],
  );
  useReturnedSandboxStage(surfaceKey, returned, read, forget);
  return surfaceKey !== null && returned !== null;
}

function landingReturnedSandbox(
  drafts: ReadonlyArray<{
    readonly id: string;
    readonly returnedSandbox: StoredReturnedSandbox | null;
  }>,
  draftId: string | null,
  userId: string | null,
): StoredReturnedSandbox | null {
  if (draftId === null) return null;
  return returnedSandboxFor(
    drafts.find((draft) => draft.id === draftId)?.returnedSandbox ?? null,
    userId,
  );
}

/**
 * The landing composer: stages its open draft's returned sandbox. Only the
 * `active` one acts: retained drafts share the window's surface. Answers
 * whether the draft holds one: that is where its Send goes.
 */
export function useLandingReturnedSandbox(
  surfaceKey: string,
  draftId: string | null,
  active: boolean,
): boolean {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const returned = useStoreWithEqualityFn(
    useLandingDraftStore,
    (state) => landingReturnedSandbox(state.drafts, draftId, userId),
    sameStoredReturnedSandbox,
  );
  const read = useCallback(
    () =>
      landingReturnedSandbox(
        useLandingDraftStore.getState().drafts,
        draftId,
        signedInUserId(),
      ),
    [draftId],
  );
  const forget = useCallback(() => {
    if (draftId !== null)
      useLandingDraftStore.getState().setDraftReturnedSandbox(draftId, null);
  }, [draftId]);
  useReturnedSandboxStage(active ? surfaceKey : null, returned, read, forget);
  return active && returned !== null;
}

/**
 * The only thing that stages a draft's returned sandbox: a give-back writes
 * the draft's record and nothing else. Puts it on the composer when the
 * draft is shown (opened, or after a reload) and the composer holds no
 * stage: its Send goes to that sandbox again, with the same create key. A
 * stage of the composer's own always wins. Any pick in the composer's picker
 * forgets the returned sandbox, and so does its stage leaving the composer
 * (sent, or replaced); a teardown taking every stage is neither, and the
 * stage is put back. The restored stage leaves with its draft: when the
 * composer stops showing the draft, it takes the stage off the surface and
 * the draft keeps it, to restore when it is shown again. `surfaceKey` is null
 * while the composer is inactive.
 */
function useReturnedSandboxStage(
  surfaceKey: string | null,
  returned: StoredReturnedSandbox | null,
  read: () => StoredReturnedSandbox | null,
  forget: () => void,
): void {
  useEffect(() => {
    if (surfaceKey === null) return;
    return onReturnedSandboxSuperseded(surfaceKey, forget);
  }, [forget, surfaceKey]);

  useEffect(() => {
    if (surfaceKey === null || returned === null) return;
    const installed = returned;
    return () => {
      // Runs before the next shown draft installs its own. Goes by what this
      // draft restored, not by the store: a deleted draft, or an account
      // switch, has already taken the draft's record away. Only a stage this
      // draft restored is released: a pick has dropped the mark, and one a
      // send or create has taken up is left to it.
      const restored = takeReturnedSandboxRestored(surfaceKey, installed);
      const stage = readStagedSandbox(surfaceKey);
      if (
        restored &&
        stage?.phase === "staged" &&
        stageIsReturnedSandbox(stage, installed)
      )
        useStagedSandboxStore.getState().clear(surfaceKey);
    };
  }, [returned, surfaceKey]);

  // A teardown (`clearAll`, an account change) takes every stage, and may run
  // after this composer installed: the install runs again after it.
  const teardowns = useStagedSandboxStore((state) => state.teardowns);
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
    markReturnedSandboxRestored(surfaceKey, returned);
  }, [read, returned, surfaceKey, teardowns]);

  const stage = useStagedSandbox(surfaceKey ?? "");
  const previousRef = useRef<{
    readonly stage: StagedSandbox | null;
    readonly teardowns: number;
  }>({ stage: null, teardowns });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { stage, teardowns };
    if (surfaceKey === null || returned === null) return;
    // A stage a teardown took was neither sent nor replaced: the draft keeps
    // its destination, and the install above puts it back.
    if (previous.teardowns !== teardowns) return;
    if (
      stageIsReturnedSandbox(previous.stage, returned) &&
      !stageIsReturnedSandbox(stage, returned)
    )
      forget();
  }, [forget, returned, stage, surfaceKey, teardowns]);
}
