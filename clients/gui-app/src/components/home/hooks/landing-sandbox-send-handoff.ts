import {
  confirmPendingSandboxSendEpic,
  handPendingSandboxSend,
  returnPendingSandboxSend,
  returnPendingSandboxSendToDraft,
  type PendingSandboxSendInput,
} from "@/lib/sandboxes/pending-sandbox-send";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";

/**
 * Where a given-back message went: `opened`, back in its composer on its
 * sandbox; `saved`, put away in Drafts with its sandbox, because the
 * composer holds a newer choice.
 */
export type LandingGiveBack =
  | { readonly kind: "opened"; readonly draftId: string }
  | { readonly kind: "saved"; readonly draftId: string };

export interface LandingSandboxSendHandoff {
  readonly isCurrent: () => boolean;
  readonly confirm: () => void;
  /**
   * `taskCreated`: the task exists, so a send that cannot go back to its
   * composer stays with it. With no task, the message is never left behind.
   */
  readonly giveBack: (taskCreated: boolean) => LandingGiveBack | null;
}

/** Landing setup returns its destination with the message if create or attach fails. */
export function handLandingSandboxSend(
  input: Omit<PendingSandboxSendInput, "request" | "epicConfirmed">,
): LandingSandboxSendHandoff | null {
  const id = handPendingSandboxSend({
    ...input,
    request: { kind: "chat", parentId: null, placement: null },
    epicConfirmed: false,
  });
  if (id === null) return null;
  const userId = useAuthStore.getState().profile?.userId ?? null;
  const isCurrent = (): boolean =>
    (useAuthStore.getState().profile?.userId ?? null) === userId &&
    usePendingSandboxSendStore.getState().sends[id]?.delivery === null;
  return {
    isCurrent,
    confirm: () => confirmPendingSandboxSendEpic(id),
    giveBack: (taskCreated) => {
      if (!isCurrent()) return null;
      const send = usePendingSandboxSendStore.getState().sends[id];
      const stage = readStagedSandbox(pendingSendSurfaceKey(id));
      if (send.epicConfirmed || stage === null) return null;
      const returnedSandbox = {
        target: stage.target,
        clientRequestId: stage.clientRequestId,
      };
      // A reused composer belongs to the newer choice. Keep this send's
      // only message and destination together on its task, or, with no
      // task, in Drafts.
      if (readStagedSandbox(input.fromSurfaceKey) !== null) {
        if (taskCreated) return null;
        const saved = returnPendingSandboxSendToDraft(id);
        if (saved.kind !== "landing-draft") return null;
        useLandingDraftStore
          .getState()
          .setDraftReturnedSandbox(saved.draftId, returnedSandbox);
        return { kind: "saved", draftId: saved.draftId };
      }
      const returned = returnPendingSandboxSend(id);
      if (returned.kind !== "landing-draft") return null;
      const store = useStagedSandboxStore.getState();
      // A fresh stage on the same sandbox: only the create's key carries
      // over, never the send's progress, failure or timing.
      store.stage(input.fromSurfaceKey, stage.target);
      if (stage.clientRequestId !== null)
        store.report(input.fromSurfaceKey, {
          clientRequestId: stage.clientRequestId,
        });
      // The draft keeps where its message was going, so a reload stages it
      // again (`useReturnedSandboxStage`).
      useLandingDraftStore
        .getState()
        .setDraftReturnedSandbox(returned.draftId, returnedSandbox);
      return { kind: "opened", draftId: returned.draftId };
    },
  };
}
