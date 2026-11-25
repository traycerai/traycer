import { useCallback, useEffect, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  markReturnedSandboxRestored,
  onReturnedSandboxSuperseded,
  returnedSandboxForDraft,
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

/**
 * The task's new-agent composer, unnamed: stages its draft's returned
 * sandbox. A modal that names its host (`hostId`) stages nothing.
 */
export function useNewConversationReturnedSandbox(
  epicId: string,
  hostId: string | null,
): void {
  const surfaceKey = hostId === null ? newConversationSurfaceKey(epicId) : null;
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const draftId = useNewConversationModalStore(
    (state) => state.draftPatchesByEpicId[epicId]?.draftId ?? null,
  );
  const returned = useStoreWithEqualityFn(
    useNewConversationModalStore,
    (state) => {
      const draft = state.draftPatchesByEpicId[epicId];
      return returnedSandboxForDraft(
        draft?.returnedSandbox ?? null,
        userId,
        "task",
        draft?.draftId ?? null,
      );
    },
    sameStoredReturnedSandbox,
  );
  const read = useCallback(() => {
    const draft =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    if ((draft?.draftId ?? null) !== draftId) return null;
    return returnedSandboxForDraft(
      draft?.returnedSandbox ?? null,
      signedInUserId(),
      "task",
      draft?.draftId ?? null,
    );
  }, [draftId, epicId]);
  const forget = useCallback(() => {
    if (read() !== null)
      useNewConversationModalStore.getState().setReturnedSandbox(epicId, null);
  }, [epicId, read]);
  useReturnedSandboxStage(surfaceKey, returned, {
    read,
    forget,
    draftId,
    epicId,
  });
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
  return returnedSandboxForDraft(
    drafts.find((draft) => draft.id === draftId)?.returnedSandbox ?? null,
    userId,
    "landing",
    draftId,
  );
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
    if (draftId !== null && read() !== null)
      useLandingDraftStore.getState().setDraftReturnedSandbox(draftId, null);
  }, [draftId, read]);
  useReturnedSandboxStage(active ? surfaceKey : null, returned, {
    read,
    forget,
    draftId,
    epicId: null,
  });
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
  source: {
    readonly read: () => StoredReturnedSandbox | null;
    readonly forget: () => void;
    readonly draftId: string | null;
    readonly epicId: string | null;
  },
): void {
  const { read, forget, draftId, epicId } = source;
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
    const { clientRequestId: stageId, userId } = returned;
    const landing =
      draftId === null ? null : { kind: "landing" as const, draftId };
    const draft =
      epicId === null ? landing : { kind: "task" as const, epicId, draftId };
    useStagedSandboxStore.getState().restore(surfaceKey, {
      ...returned,
      ...(draft !== null && userId !== null
        ? { returnedDraft: { ...draft, userId, stageId } }
        : {}),
    });
    markReturnedSandboxRestored(surfaceKey, returned);
  }, [read, returned, surfaceKey, teardowns, draftId, epicId]);

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
