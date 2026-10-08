import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import type { ChatRunSettings } from "@traycer/protocol/persistence/epic/schemas";
import { subagentCardPath } from "@/components/chat/segments/subagent-display";
import { knownHarnessId } from "@/lib/chat/sender-display";
import type { SubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { useEpicContinueSubagent } from "@/hooks/epic/use-epic-continue-subagent-mutation";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  openCreatedChatWhenProjected,
  type CancelFn,
} from "@/lib/commands/actions/new-chat";
import type {
  ChatMessage as ChatMessageModel,
  SubagentSegment,
} from "@/stores/composer/chat-store";

/**
 * "Continue as chat" for the subagent whose conversation is open: the host
 * copies that conversation into a chat of its own, which opens in this tab.
 * The copy is independent - nothing sent to it reaches the subagent or the
 * chat that spawned it.
 */
export interface SubagentContinueAsChat {
  readonly run: () => void;
  /**
   * The request is in flight, or the subagent has not finished: its
   * conversation is still being written, so there is nothing whole to copy.
   */
  readonly isPending: boolean;
}

/** The open card and the harness of the assistant turn it sits in. */
function openSubagentCard(
  messages: ReadonlyArray<ChatMessageModel>,
  openId: string | null,
): {
  readonly card: SubagentSegment;
  readonly provider: GuiHarnessId | null;
} | null {
  if (openId === null) return null;
  for (const message of messages) {
    const card = subagentCardPath([message], openId)?.at(-1);
    if (card === undefined) continue;
    // A heard-from id off a `1.22` row may name a harness this build cannot
    // continue a subagent on; `null` is the "not offered" branch below.
    const meta = message.assistantMeta;
    return {
      card,
      provider: meta === null ? null : knownHarnessId(meta.provider),
    };
  }
  return null;
}

/**
 * The open card's action, or `null` where it is not offered - no view open, a
 * harness whose subagents cannot be continued, a reader who cannot act on the
 * chat, a host that predates the verb - and outside a chat tile altogether (an
 * isolated render, a test). The control then is not drawn.
 */
export const SubagentContinueAsChatContext =
  createContext<SubagentContinueAsChat | null>(null);

export function useSubagentContinueAsChatAction(): SubagentContinueAsChat | null {
  return use(SubagentContinueAsChatContext);
}

interface UseSubagentContinueAsChatArgs {
  readonly drillIn: SubagentDrillIn;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly viewTabId: string;
  /** The chat's run settings, which name its harness; `null` before any. */
  readonly settings: ChatRunSettings | null;
  /** The reader may act on this chat. */
  readonly canAct: boolean;
  /**
   * This tile shows the live chat. A published or replica copy is served by
   * a host that holds no session for it, so there is nothing to continue.
   */
  readonly isLiveSession: boolean;
}

/** Builds the tile's {@link SubagentContinueAsChat} for the open card. */
export function useSubagentContinueAsChat(
  args: UseSubagentContinueAsChatArgs,
): SubagentContinueAsChat | null {
  const { chatId, drillIn, epicId, hostId, viewTabId } = args;
  const canAct = args.canAct && args.isLiveSession;
  const { close, openId } = drillIn;
  const hostSupported = useHostSupportsMethod(hostId, "epic.continueSubagent");
  const { isPending: requestPending, mutate } = useEpicContinueSubagent();
  const owner = useMemo(
    () => openSubagentCard(args.messages, openId),
    [args.messages, openId],
  );
  const card = owner?.card ?? null;
  // The harness that RAN the subagent: the turn the card sits in. A chat can
  // change harness between turns, and its settings name the next turn's - so
  // they would hide the control on a finished Codex card after a switch away
  // and offer it on a card the host then refuses. The settings answer only
  // for a turn that recorded no provider.
  const harnessId = owner?.provider ?? args.settings?.harnessId ?? null;
  // A value, not the card: it is a new object on every streamed token.
  const isStreaming = card?.isStreaming === true;
  // A workflow run rides a subagent card and is a fleet, not a conversation.
  const offered =
    card !== null &&
    card.workflowMeta === null &&
    canAct &&
    hostSupported &&
    (harnessId === "codex" || harnessId === "claude");
  // What is open when an answer ARRIVES, which need not be what was open
  // when it was asked for: the reader can step to another card, or back to
  // the chat, while the request is in flight. Synced in a LAYOUT effect: a
  // passive one runs after the commit has yielded, and an answer that lands
  // in that gap would read the card the reader had just left.
  const openIdRef = useRef(openId);
  useLayoutEffect(() => {
    openIdRef.current = openId;
  }, [openId]);
  // The wait for the new chat's record, so a tile that unmounts mid-wait
  // leaves no subscription behind.
  const cancelPendingOpenRef = useRef<CancelFn | null>(null);
  useEffect(
    () => () => {
      cancelPendingOpenRef.current?.();
      cancelPendingOpenRef.current = null;
    },
    [],
  );
  const run = useCallback((): void => {
    if (openId === null) return;
    mutate(
      { epicId, chatId, blockId: openId },
      {
        onSuccess: (response) => {
          // The hook words a refusal; the view stays open on one.
          if (response.kind === "refused") return;
          // The chat exists on the host and is not in this renderer's
          // projection yet: its record arrives with the re-read the mutation
          // just asked for. Opening a tile for it now would open nothing, so
          // the open waits for the record, as every create-then-open does.
          cancelPendingOpenRef.current?.();
          cancelPendingOpenRef.current = openCreatedChatWhenProjected({
            epicId: response.epicId,
            tabId: viewTabId,
            chatId: response.chatId,
            hostId,
            placement: null,
            source: "direct_ui",
          });
          // The chat opens whatever the reader is looking at now - they
          // asked for it. The view closes only if it still shows the card
          // the chat was made from: another card opened since is theirs.
          if (openIdRef.current === openId) close();
        },
      },
    );
  }, [chatId, close, epicId, hostId, mutate, openId, viewTabId]);
  const isPending = requestPending || isStreaming;
  return useMemo(
    () => (offered ? { run, isPending } : null),
    [isPending, offered, run],
  );
}
