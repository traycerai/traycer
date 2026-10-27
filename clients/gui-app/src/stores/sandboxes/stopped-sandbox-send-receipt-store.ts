import { create } from "zustand";
import type { ReturnedPendingSandboxSend } from "@/lib/sandboxes/pending-sandbox-send";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  type StagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import {
  newConversationSurfaceKey,
  surfaceHostKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import {
  usePendingSandboxSendStore,
  type PendingSandboxSend,
} from "@/stores/sandboxes/pending-sandbox-send-store";

type RestoredMessage =
  | Extract<ReturnedPendingSandboxSend, { readonly kind: "landing-draft" }>
  | (Extract<ReturnedPendingSandboxSend, { readonly kind: "task" }> & {
      readonly draftId: string | null;
    });

export interface StoppedSandboxSendReceipt {
  readonly id: string;
  readonly userId: string | null;
  readonly epicId: string;
  readonly sandboxId: string;
  readonly name: string;
  readonly returned: RestoredMessage;
  readonly confirmedAt: number;
  readonly existingSendIds: ReadonlySet<string>;
  readonly picks: Readonly<Record<string, ReceiptPick>>;
}

interface ReceiptPick {
  readonly pin: string | undefined;
  readonly target: StagedSandbox["target"] | undefined;
}

interface ReceiptState {
  readonly receipts: Readonly<Record<string, StoppedSandboxSendReceipt>>;
  readonly strips: Readonly<Record<string, number>>;
}

// Receipts are window-local attention, never a second persisted pending send.
export const useStoppedSandboxSendReceiptStore = create<ReceiptState>(() => ({
  receipts: {},
  strips: {},
}));

export function stoppedReceiptStripKey(
  userId: string | null,
  epicId: string,
): string {
  return JSON.stringify([userId, epicId]);
}

export function stoppedReceiptPicks(
  epicId: string,
  pins: Readonly<Partial<Record<string, string>>>,
  stages: Readonly<Partial<Record<string, StagedSandbox>>>,
): Readonly<Record<string, ReceiptPick>> {
  const taskKey = newConversationSurfaceKey(epicId);
  const keys = new Set([taskKey, ...Object.keys(pins), ...Object.keys(stages)]);
  return Object.fromEntries(
    [...keys]
      .filter(
        (key) =>
          key === taskKey || key.startsWith(surfaceHostKey("composer", "")),
      )
      .map((key) => [key, { pin: pins[key], target: stages[key]?.target }]),
  );
}

/** Called only after the existing give-back has replaced the pending copy. */
export function recordStoppedSandboxSend(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  name: string,
  returned: ReturnedPendingSandboxSend,
): void {
  if (
    stage.createdSandboxId === null ||
    (returned.kind !== "task" && returned.kind !== "landing-draft")
  )
    return;
  const receipt: StoppedSandboxSendReceipt = {
    id: send.id,
    userId: send.userId,
    epicId: send.epicId,
    sandboxId: stage.createdSandboxId,
    name,
    returned:
      returned.kind === "task"
        ? {
            ...returned,
            draftId:
              useNewConversationModalStore.getState().draftPatchesByEpicId[
                send.epicId
              ]?.draftId ?? null,
          }
        : returned,
    confirmedAt: Date.now(),
    existingSendIds: new Set(
      Object.keys(usePendingSandboxSendStore.getState().sends),
    ),
    picks: stoppedReceiptPicks(
      send.epicId,
      useSurfaceHostSelectionStore.getState().selections,
      useStagedSandboxStore.getState().bySurface,
    ),
  };
  useStoppedSandboxSendReceiptStore.setState((state) => ({
    receipts: { ...state.receipts, [send.id]: receipt },
  }));
}
