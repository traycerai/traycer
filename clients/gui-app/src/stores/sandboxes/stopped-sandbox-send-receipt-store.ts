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
  | (Extract<ReturnedPendingSandboxSend, { readonly kind: "chat" }> & {
      readonly draftId: null;
    })
  | Extract<ReturnedPendingSandboxSend, { readonly kind: "landing-draft" }>
  | (Extract<ReturnedPendingSandboxSend, { readonly kind: "task" }> & {
      readonly draftId: string | null;
    });

type ReceiptOutcome =
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "stopped";
      readonly sandboxId: string;
      readonly name: string;
      readonly confirmedAt: number;
    };

export type StoppedSandboxSendReceipt = ReceiptOutcome & {
  readonly id: string;
  readonly userId: string | null;
  readonly epicId: string;
  readonly chatId?: string;
  readonly returned: RestoredMessage;
  readonly existingSendIds: ReadonlySet<string>;
  readonly picks: Readonly<Record<string, ReceiptPick>>;
};

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
  if (stage.createdSandboxId === null) return;
  recordReturnedSandboxSend(send, returned, {
    kind: "stopped",
    sandboxId: stage.createdSandboxId,
    name,
    confirmedAt: Date.now(),
  });
}

/** Cancelling returns only the message; it makes no claim about the sandbox. */
export function recordCancelledSandboxSend(
  send: PendingSandboxSend,
  returned: ReturnedPendingSandboxSend,
): void {
  recordReturnedSandboxSend(send, returned, { kind: "cancelled" });
}

function recordReturnedSandboxSend(
  send: PendingSandboxSend,
  returned: ReturnedPendingSandboxSend,
  outcome: ReceiptOutcome,
): void {
  if (
    returned.kind !== "task" &&
    returned.kind !== "landing-draft" &&
    returned.kind !== "chat"
  )
    return;
  let restored: RestoredMessage;
  if (returned.kind === "task") {
    restored = {
      ...returned,
      draftId:
        useNewConversationModalStore.getState().draftPatchesByEpicId[
          send.epicId
        ]?.draftId ?? null,
    };
  } else if (returned.kind === "chat") {
    restored = { ...returned, draftId: null };
  } else {
    restored = returned;
  }
  const receipt: StoppedSandboxSendReceipt = {
    ...outcome,
    id: send.id,
    userId: send.userId,
    epicId: send.epicId,
    ...(send.request.kind === "message" ? { chatId: send.request.chatId } : {}),
    returned: restored,
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
