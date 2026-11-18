import {
  confirmPendingSandboxSendEpic,
  handPendingSandboxSend,
  returnPendingSandboxSend,
  returnPendingSandboxSendToDraft,
  stagedSandboxDestination,
  type PendingSandboxSendInput,
} from "@/lib/sandboxes/pending-sandbox-send";
import { useAuthStore } from "@/stores/auth/auth-store";
import { readStagedSandbox } from "@/stores/composer/staged-sandbox-store";
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
  /** Returns the message; a setup that fails leaves no task to keep it. */
  readonly giveBack: () => LandingGiveBack | null;
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
    giveBack: () => {
      if (!isCurrent()) return null;
      const send = usePendingSandboxSendStore.getState().sends[id];
      const stage = readStagedSandbox(pendingSendSurfaceKey(id));
      if (send.epicConfirmed || stage === null) return null;
      const returnedSandbox = stagedSandboxDestination(stage);
      // A reused composer belongs to the newer choice. Keep this send's
      // only message and destination together in Drafts.
      if (readStagedSandbox(input.fromSurfaceKey) !== null) {
        const saved = returnPendingSandboxSendToDraft(id);
        if (saved.kind !== "landing-draft") return null;
        useLandingDraftStore
          .getState()
          .setDraftReturnedSandbox(saved.draftId, returnedSandbox);
        return { kind: "saved", draftId: saved.draftId };
      }
      const returned = returnPendingSandboxSend(id);
      if (returned.kind !== "landing-draft") return null;
      // The draft keeps where its message was going: the composer showing
      // it stages a fresh stage on that sandbox with the create's key only,
      // never the send's progress, failure or timing.
      useLandingDraftStore
        .getState()
        .setDraftReturnedSandbox(returned.draftId, returnedSandbox);
      return { kind: "opened", draftId: returned.draftId };
    },
  };
}
