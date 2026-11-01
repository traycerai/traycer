import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import { ChatSandboxFooter } from "@/components/chat/chat-sandbox-footer";
import { chatSandboxStateLine } from "@/components/epic-canvas/renderers/chat-sandbox-state-line";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { Button } from "@/components/ui/button";
import { useChatSandboxState } from "@/hooks/sandboxes/use-chat-sandbox-state";
import { useRestedTaskMessageLine } from "@/hooks/sandboxes/use-rested-task-message-line";
import { resolveChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import {
  useSandboxList,
  sandboxListReadSentAt,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxOperationFailure } from "@/hooks/sandboxes/use-sandbox-operation-failure";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import {
  CHOOSE_ANOTHER_HOST,
  restedDraftLine,
  returnedSandboxMessageLine,
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

const FINISHED_RECEIPT_STATES: ReadonlySet<HostSandboxState> = new Set([
  "awake",
  "destroyed",
  "released",
]);
/** A rested receipt says the rest, so it lasts only as long as the rest. */
const RESTED_RECEIPT_STATES: ReadonlySet<HostSandboxState> = new Set([
  "suspended",
  "stopped",
]);

function receiptScopeKey(
  userId: string | null,
  epicId: string,
  chatId: string | undefined,
): string {
  return chatId === undefined
    ? stoppedReceiptStripKey(userId, epicId)
    : JSON.stringify([userId, epicId, chatId]);
}

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
          !state.strips[
            receiptScopeKey(userId, receipt.epicId, receipt.chatId)
          ],
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
  readonly chatId?: string;
}): ReactNode {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const key = receiptScopeKey(userId, props.epicId, props.chatId);
  const receipts = useStoppedSandboxSendReceiptStore(
    useShallow((state) =>
      Object.values(state.receipts).filter(
        (receipt) =>
          receipt.userId === userId &&
          receipt.epicId === props.epicId &&
          receipt.chatId === props.chatId,
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
            receiptScopeKey(receipt.userId, receipt.epicId, receipt.chatId) ===
              key &&
            (receipt.returned.kind === "task" ||
              receipt.returned.kind === "chat")
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
  const { receipt, tabId } = props;
  if (receipt.kind === "stopped")
    return <StoppedReceiptOwner receipt={receipt} tabId={tabId} />;
  // A sandbox's own state is nobody's gesture: it is said in its task, never
  // in a toast.
  if (receipt.kind === "rested" || receipt.kind === "ended")
    return tabId === null ? null : (
      <SandboxStateReceipt receipt={receipt} tabId={tabId} />
    );
  return (
    <ReturnedSendReceipt
      receipt={receipt}
      tabId={tabId}
      startSandbox={null}
      sandboxLine={null}
    />
  );
}

/** The sandbox's own line, by the resolver its chat would consult. */
function SandboxStateReceipt(props: {
  readonly receipt: Extract<
    StoppedSandboxSendReceipt,
    { readonly kind: "rested" | "ended" }
  >;
  readonly tabId: string;
}): ReactNode {
  const { receipt } = props;
  const state = useChatSandboxState(receipt.epicId, receipt.hostId, false);
  const { line } = resolveChatSandbox(state, RECEIPT_VIEWER);
  const taskMessageLine = useRestedTaskMessageLine(receipt.epicId);
  // That line says this and where the message is: the task strip shows it.
  if (receipt.returned.kind === "task" && taskMessageLine !== null) return null;
  let sandboxLine: ReactNode = null;
  // A state not known here says nothing of this task: the receipt's sentence does.
  if (line !== null && state.kind !== "pending") {
    // Only a message put away in Drafts needs saying: one back in the
    // composer is in plain sight.
    const inDrafts =
      receipt.kind === "rested" && receipt.returned.kind === "landing-draft";
    const slot = chatSandboxStateLine(line, null);
    sandboxLine = (
      <>
        {line.place === "footer" ? <ChatSandboxFooter line={line} /> : null}
        {slot === null || inDrafts ? null : (
          <>
            <span>{slot.line}</span>
            {/* The strip sits above the tiles, or in a tile bound elsewhere:
                its actions bind the host a chat of this sandbox would. Only
                the binding, since this is no tab to mirror drafts for. */}
            <TabHostContext.Provider value={receipt.hostId}>
              {slot.actions}
            </TabHostContext.Provider>
          </>
        )}
        {inDrafts ? <span>{restedDraftLine(line.text)}</span> : null}
      </>
    );
  }
  return (
    <ReturnedSendReceipt
      receipt={receipt}
      tabId={props.tabId}
      startSandbox={null}
      sandboxLine={sandboxLine}
    />
  );
}

/** Only the line is read; the task's composer decides what its send may do. */
const RECEIPT_VIEWER = {
  reachable: false,
  canEdit: false,
  ownedByViewer: false,
  environmentOwned: false,
} as const;

/** Capture the host-bound mutation here; a background toast renders outside that provider. */
function StoppedReceiptOwner(props: {
  readonly receipt: Extract<
    StoppedSandboxSendReceipt,
    { readonly kind: "stopped" }
  >;
  readonly tabId: string | null;
}): ReactNode {
  const { receipt } = props;
  const verb = useSandboxVerb(receipt.sandboxId);
  const mutate = verb.mutate;
  const start = useCallback((): void => {
    if ((useAuthStore.getState().profile?.userId ?? null) !== receipt.userId)
      return;
    mutate("start", {
      onSuccess: (outcome) => {
        if (
          outcome.kind === "gone" ||
          (outcome.kind === "settled" && outcome.state === "awake")
        )
          dismissReceipt(receipt.id);
      },
    });
  }, [mutate, receipt.id, receipt.userId]);
  const operation = useSandboxOperation(receipt.sandboxId);
  const row = useSandboxList().data?.sandboxes.find(
    (sandbox) => sandbox.id === receipt.sandboxId,
  );
  const pending =
    verb.isPending || row?.state === "starting" || row?.state === "resuming";
  const failure = useSandboxOperationFailure({
    sandboxId: receipt.sandboxId,
    name: receipt.name,
    hostId: row?.hostId,
    operation:
      operation?.kind === "failed" && operation.verb === "start"
        ? operation
        : null,
    busy: pending,
    onRetry: start,
  });
  const startSandbox = useMemo(
    () => ({ start, pending, failure }),
    [start, pending, failure],
  );
  return (
    <ReturnedSendReceipt
      {...props}
      startSandbox={startSandbox}
      sandboxLine={null}
    />
  );
}

function ReturnedSendReceipt(props: {
  readonly receipt: StoppedSandboxSendReceipt;
  readonly tabId: string | null;
  readonly startSandbox: {
    readonly start: () => void;
    readonly pending: boolean;
    readonly failure: ReactNode;
  } | null;
  /** Said in place of the receipt's sentence: the sandbox's own line. */
  readonly sandboxLine: ReactNode;
}): ReactNode {
  const { receipt, sandboxLine } = props;
  const startSandbox = props.startSandbox;
  const router = use(CommandPaletteRouterContext);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const sends = usePendingSandboxSendStore((state) => state.sends);
  const pins = useSurfaceHostSelectionStore((state) => state.selections);
  const stages = useStagedSandboxStore((state) => state.bySurface);
  const taskDraftId = useNewConversationModalStore(
    (state) => state.draftPatchesByEpicId[receipt.epicId]?.draftId ?? null,
  );
  const chatDraftRevision = useComposerDraftStore((state) =>
    receipt.returned.kind === "chat"
      ? (state.drafts[receipt.returned.chatId]?.revision ?? null)
      : null,
  );
  const returnedDraftId = receipt.returned.draftId;
  const savedDraftPresent = useLandingDraftStore((state) =>
    state.drafts.some((draft) => draft.id === returnedDraftId),
  );
  const sandboxList = useSandboxList();
  const currentPicks = stoppedReceiptPicks(receipt.epicId, pins, stages);
  const readAt = sandboxListReadSentAt(sandboxList.data);
  const sandboxId =
    receipt.kind === "cancelled" || receipt.kind === "recovered"
      ? null
      : receipt.sandboxId;
  const picksChanged =
    receipt.kind !== "recovered" &&
    (Object.keys(currentPicks).length !== Object.keys(receipt.picks).length ||
      Object.entries(currentPicks).some(
        ([key, pick]) =>
          pick.pin !== receipt.picks[key]?.pin ||
          pick.target !== receipt.picks[key]?.target,
      ));
  const row = sandboxList.data?.sandboxes.find(
    (sandbox) => sandbox.id === sandboxId,
  );
  const obsolete =
    userId !== receipt.userId ||
    !returnedMessagePresent(
      receipt.returned,
      taskDraftId,
      savedDraftPresent,
      chatDraftRevision,
    ) ||
    Object.values(sends).some(
      (send) =>
        send.userId === userId &&
        !receipt.existingSendIds.has(send.id) &&
        (receipt.returned.kind === "landing-draft" ||
          send.epicId === receipt.epicId),
    ) ||
    picksChanged ||
    (!sandboxList.isError && rowOutlivedReceipt(receipt, row, readAt));
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
    } else if (receipt.returned.kind === "task" && props.tabId !== null) {
      useNewConversationModalOpenStore.getState().open({
        epicId: receipt.epicId,
        tabId: props.tabId,
        placement: receipt.returned.placement,
        parentId: receipt.returned.parentId,
        hostId: null,
      });
    }
  }, [receipt, router, props.tabId]);
  const content = useMemo(
    () => (
      <div
        data-testid="sandbox-stopped-line"
        className="flex flex-col gap-2 text-ui-xs"
      >
        {sandboxLine ?? (
          <span>
            {receipt.kind === "stopped"
              ? stoppedSandboxLine(
                  receipt.name,
                  receipt.returned.kind === "landing-draft",
                )
              : returnedSandboxMessageLine(
                  receipt.returned.kind === "landing-draft",
                )}
          </span>
        )}
        <div className="flex flex-wrap gap-2">
          {receipt.returned.kind === "landing-draft" ||
          // Back in this task's composer: the way back to it, where Stop's
          // Choose another host is not offered.
          (receipt.returned.kind === "task" &&
            props.tabId !== null &&
            startSandbox === null) ? (
            <Button
              type="button"
              variant="link"
              size="inline-xs"
              onClick={openDraft}
            >
              Open draft
            </Button>
          ) : null}
          {startSandbox === null ? null : (
            <>
              <Button
                type="button"
                variant="link"
                size="inline-xs"
                disabled={startSandbox.pending}
                onClick={startSandbox.start}
              >
                Start
              </Button>
              {receipt.returned.kind === "chat" ? null : (
                <Button
                  type="button"
                  variant="link"
                  size="inline-xs"
                  onClick={openDraft}
                >
                  {CHOOSE_ANOTHER_HOST}
                </Button>
              )}
            </>
          )}
        </div>
        {startSandbox?.failure}
      </div>
    ),
    [receipt, openDraft, startSandbox, props.tabId, sandboxLine],
  );
  const onToastDismissRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (props.tabId !== null || obsolete) return;
    const id = `sandbox-stopped:${receipt.id}`;
    let active = true;
    onToastDismissRef.current = () => {
      if (active) dismissReceipt(receipt.id);
    };
    return () => {
      // Sonner can deliver this lifetime's dismissal after a new toast opens.
      active = false;
      onToastDismissRef.current = undefined;
      toast.dismiss(id);
    };
  }, [props.tabId, obsolete, receipt.id]);
  useEffect(() => {
    if (props.tabId !== null || obsolete) return;
    toast(content, {
      id: `sandbox-stopped:${receipt.id}`,
      duration: Infinity,
      onDismiss: onToastDismissRef.current,
    });
  }, [content, props.tabId, obsolete, receipt.id]);
  return obsolete || props.tabId === null ? null : content;
}

/** A list read after the receipt shows its sandbox has moved on. */
function rowOutlivedReceipt(
  receipt: StoppedSandboxSendReceipt,
  row: SandboxSummary | undefined,
  readAt: number | null,
): boolean {
  if (receipt.kind !== "stopped" && receipt.kind !== "rested") return false;
  if (readAt === null || readAt <= receipt.confirmedAt) return false;
  if (row === undefined) return true;
  return receipt.kind === "stopped"
    ? FINISHED_RECEIPT_STATES.has(row.state)
    : !RESTED_RECEIPT_STATES.has(row.state);
}

function returnedMessagePresent(
  returned: StoppedSandboxSendReceipt["returned"],
  taskDraftId: string | null,
  savedDraftPresent: boolean,
  chatRevision: number | null,
): boolean {
  if (returned.kind === "task") return taskDraftId === returned.draftId;
  if (returned.kind === "chat") return chatRevision === returned.revision;
  return savedDraftPresent;
}
