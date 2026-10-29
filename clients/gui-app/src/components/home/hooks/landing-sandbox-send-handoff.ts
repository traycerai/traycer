import {
  confirmPendingSandboxSendEpic,
  handPendingSandboxSend,
  returnPendingSandboxSend,
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

export interface LandingSandboxSendHandoff {
  readonly isCurrent: () => boolean;
  readonly confirm: () => void;
  readonly giveBack: () => string | null;
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
      // A reused composer belongs to the newer choice. Keep this send's
      // only message and destination together on its task instead.
      if (
        send.epicConfirmed ||
        stage === null ||
        readStagedSandbox(input.fromSurfaceKey) !== null
      )
        return null;
      const returned = returnPendingSandboxSend(id);
      if (returned.kind !== "landing-draft") return null;
      const store = useStagedSandboxStore.getState();
      store.stage(input.fromSurfaceKey, stage.target);
      store.report(input.fromSurfaceKey, { ...stage, sendTaken: false });
      // The draft keeps where its message was going, so a reload stages it
      // again (`useReturnedSandboxStage`).
      useLandingDraftStore
        .getState()
        .setDraftReturnedSandbox(returned.draftId, {
          target: stage.target,
          clientRequestId: stage.clientRequestId,
        });
      return returned.draftId;
    },
  };
}
