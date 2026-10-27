import { use, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import { Button } from "@/components/ui/button";
import {
  useSandboxList,
  sandboxListReadSentAt,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import {
  CHOOSE_ANOTHER_HOST,
  stoppedSandboxLine,
} from "@/lib/sandboxes/sandbox-strings";
import { draftTabIntent } from "@/lib/tab-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";

import {
  stoppedReceiptPicks,
  stoppedReceiptStripKey,
  useStoppedSandboxSendReceiptStore,
  type StoppedSandboxSendReceipt,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";

function dismissReceipt(id: string): void {
  useStoppedSandboxSendReceiptStore.setState((state) => ({
    receipts: Object.fromEntries(
      Object.entries(state.receipts).filter(([key]) => key !== id),
    ),
  }));
  toast.dismiss(`sandbox-stopped:${id}`);
}

/** The app owns background receipts so closing a task cannot hide its returned draft. */
export function StoppedSandboxSendReceipts(): ReactNode {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const receipts = useStoppedSandboxSendReceiptStore(
    useShallow((state) =>
      Object.values(state.receipts).filter(
        (receipt) =>
          receipt.userId === userId &&
          !state.strips[stoppedReceiptStripKey(userId, receipt.epicId)],
      ),
    ),
  );
  useEffect(
    () => () => {
      for (const receipt of Object.values(
        useStoppedSandboxSendReceiptStore.getState().receipts,
      )) {
        if (receipt.userId === userId) dismissReceipt(receipt.id);
      }
    },
    [userId],
  );
  return receipts.map((receipt) => (
    <StoppedReceipt key={receipt.id} receipt={receipt} tabId={null} />
  ));
}

/** A mounted task keeps its confirmation beside the setup line it replaced. */
export function StoppedSandboxSendReceiptStrip(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const key = stoppedReceiptStripKey(userId, props.epicId);
  const receipts = useStoppedSandboxSendReceiptStore(
    useShallow((state) =>
      Object.values(state.receipts).filter(
        (receipt) =>
          receipt.userId === userId && receipt.epicId === props.epicId,
      ),
    ),
  );
  useEffect(() => {
    useStoppedSandboxSendReceiptStore.setState((state) => ({
      strips: { ...state.strips, [key]: (state.strips[key] ?? 0) + 1 },
    }));
    return () => {
      const remaining =
        (useStoppedSandboxSendReceiptStore.getState().strips[key] ?? 1) - 1;
      if (remaining === 0) {
        for (const receipt of Object.values(
          useStoppedSandboxSendReceiptStore.getState().receipts,
        )) {
          if (
            stoppedReceiptStripKey(receipt.userId, receipt.epicId) === key &&
            receipt.returned.kind === "task"
          )
            dismissReceipt(receipt.id);
        }
      }
      useStoppedSandboxSendReceiptStore.setState((state) => ({
        strips: { ...state.strips, [key]: remaining },
      }));
    };
  }, [key]);
  return receipts.map((receipt) => (
    <StoppedReceipt key={receipt.id} receipt={receipt} tabId={props.tabId} />
  ));
}

function StoppedReceipt(props: {
  readonly receipt: StoppedSandboxSendReceipt;
  readonly tabId: string | null;
}): ReactNode {
  const { receipt } = props;
  const router = use(CommandPaletteRouterContext);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const sends = usePendingSandboxSendStore((state) => state.sends);
  const pins = useSurfaceHostSelectionStore((state) => state.selections);
  const stages = useStagedSandboxStore((state) => state.bySurface);
  const taskDraftId = useNewConversationModalStore(
    (state) => state.draftPatchesByEpicId[receipt.epicId]?.draftId ?? null,
  );
  const returnedDraftId = receipt.returned.draftId;
  const savedDraftPresent = useLandingDraftStore((state) =>
    state.drafts.some((draft) => draft.id === returnedDraftId),
  );
  const sandboxList = useSandboxList();
  const verb = useSandboxVerb(receipt.sandboxId);
  const currentPicks = stoppedReceiptPicks(receipt.epicId, pins, stages);
  const readAt = sandboxListReadSentAt(sandboxList.data);
  const row = sandboxList.data?.sandboxes.find(
    (sandbox) => sandbox.id === receipt.sandboxId,
  );
  const obsolete =
    userId !== receipt.userId ||
    (receipt.returned.kind === "task"
      ? taskDraftId !== receipt.returned.draftId
      : !savedDraftPresent) ||
    Object.values(sends).some(
      (send) =>
        send.userId === userId &&
        !receipt.existingSendIds.has(send.id) &&
        (receipt.returned.kind === "landing-draft" ||
          send.epicId === receipt.epicId),
    ) ||
    Object.keys(currentPicks).length !== Object.keys(receipt.picks).length ||
    Object.entries(currentPicks).some(
      ([key, pick]) =>
        pick.pin !== receipt.picks[key]?.pin ||
        pick.target !== receipt.picks[key]?.target,
    ) ||
    (!sandboxList.isError &&
      readAt !== null &&
      readAt > receipt.confirmedAt &&
      row?.state !== "stopped");
  useEffect(() => {
    if (obsolete) dismissReceipt(receipt.id);
  }, [obsolete, receipt.id]);
  const openDraft = useCallback((): void => {
    if ((useAuthStore.getState().profile?.userId ?? null) !== receipt.userId)
      return;
    dismissReceipt(receipt.id);
    if (receipt.returned.kind === "landing-draft") {
      useLandingDraftStore.getState().openDraft(receipt.returned.draftId);
      router?.navigateToTabIntent(draftTabIntent(receipt.returned.draftId));
    } else if (props.tabId !== null) {
      useNewConversationModalOpenStore.getState().open({
        epicId: receipt.epicId,
        tabId: props.tabId,
        placement: receipt.returned.placement,
        parentId: receipt.returned.parentId,
        hostId: null,
      });
    }
  }, [receipt, router, props.tabId]);
  const startSandbox = verb.mutate;
  const start = useCallback(() => {
    if ((useAuthStore.getState().profile?.userId ?? null) !== receipt.userId)
      return;
    startSandbox("start");
    dismissReceipt(receipt.id);
  }, [receipt.id, receipt.userId, startSandbox]);
  const content = useMemo(
    () => (
      <div
        data-testid="sandbox-stopped-line"
        className="flex flex-col gap-2 text-ui-xs"
      >
        <span>
          {stoppedSandboxLine(
            receipt.name,
            receipt.returned.kind === "landing-draft",
          )}
        </span>
        <div className="flex flex-wrap gap-2">
          {receipt.returned.kind === "landing-draft" ? (
            <Button
              type="button"
              variant="link"
              size="inline-xs"
              onClick={openDraft}
            >
              Open draft
            </Button>
          ) : null}
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            disabled={verb.isPending}
            onClick={start}
          >
            Start
          </Button>
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            onClick={openDraft}
          >
            {CHOOSE_ANOTHER_HOST}
          </Button>
        </div>
      </div>
    ),
    [receipt, openDraft, verb.isPending, start],
  );
  useEffect(() => {
    if (props.tabId !== null || obsolete) return;
    const id = `sandbox-stopped:${receipt.id}`;
    toast(content, {
      id,
      duration: Infinity,
      onDismiss: () => dismissReceipt(receipt.id),
    });
    return () => {
      toast.dismiss(id);
    };
  }, [content, props.tabId, obsolete, receipt.id]);
  return obsolete || props.tabId === null ? null : content;
}
