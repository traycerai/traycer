import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import { useChatHydrateMutation } from "@/hooks/chats/use-chat-hydrate-mutation";
import { composerDraftIsEmpty } from "@/hooks/chats/use-initial-chat-handoff-driver";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { holdChatOnItsHost } from "@/lib/chats/chat-continuing-on-host";
import {
  EVICTED_SEND_FAILED_MESSAGE,
  isEvictedChatRefusal,
} from "@/lib/chats/evicted-chat-refusal";
import {
  holdComposerContentImageRoots,
  releaseComposerContentImageRoots,
} from "@/lib/composer/composer-content-image-roots";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import {
  CHAT_ACTION_REPORT_CONTEXT,
  showErrorNoticeToast,
} from "@/lib/toast/chat-error-notice-toast";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { displacedRestorationNotice } from "@/stores/chats/chat-queue-reconciler";
import type { PendingUserMessage } from "@/stores/chats/chat-session-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

/** A message held until the chat's host holds the chat again. */
export interface ParkedEvictedSend {
  readonly input: ChatComposerSubmitInput;
  /** The pending row the transcript draws while the message waits. */
  readonly row: PendingUserMessage;
}

export interface EvictedChatSend {
  /**
   * Whether a message asks the chat's host to bring the chat back before it
   * is sent: while the pool serves the chat because the host dropped its
   * records, after the host refused a message for that reason, and while an
   * earlier message still waits, so the two go in order.
   */
  readonly parks: boolean;
  /** Whether the pool serves the chat; a parked message waits until it does not. */
  readonly served: boolean;
  /** The messages waiting, oldest first. */
  readonly parked: readonly ParkedEvictedSend[];
  /** Whether the host holds the chat again, so the parked messages may go. */
  readonly ready: boolean;
  /**
   * Parks a message and, for the first one, asks the host for the chat. The
   * composer clears as it does for any send, and this hook holds the message
   * from here: a message that cannot go comes back to the composer.
   */
  readonly park: (
    input: ChatComposerSubmitInput,
    sender: UserMessageSender,
  ) => void;
  /** Takes the parked messages to send them; each is answered by `settle`. */
  readonly take: () => readonly ParkedEvictedSend[];
  /** How a taken message went: one that was not accepted comes back. */
  readonly settle: (send: ParkedEvictedSend, accepted: boolean) => void;
  /** The host refused a message on its ack instead of the request. */
  readonly refuse: () => void;
}

function parkedSend(
  input: ChatComposerSubmitInput,
  sender: UserMessageSender,
): ParkedEvictedSend {
  return {
    input,
    row: {
      clientActionId: uuidv4(),
      messageId: uuidv4(),
      content: input.content,
      attachments: input.attachments,
      sender,
      settings: input.settings,
      timestamp: Date.now(),
      restore: input.restore,
      accountContext: useAccountContextStore.getState().accountContext,
      deliveryPolicy: input.deliveryPolicy,
      restoreWorktreeIntent: null,
    },
  };
}

function imageRootsHolder(send: ParkedEvictedSend): string {
  return `evicted-send:${send.row.clientActionId}`;
}

/**
 * Puts a message that did not go back in the composer. A newer draft there
 * wins, and the message is stated in a toast that quotes it, the rule a failed
 * send's restoration follows. Answers whether the composer took it.
 */
function handBack(chatId: string, send: ParkedEvictedSend): boolean {
  const { restore } = send.input;
  const restored = composerDraftIsEmpty(chatId);
  if (restored) {
    const drafts = useComposerDraftStore.getState();
    drafts.replaceDraft(chatId, restore.content, null);
    drafts.restoreBrowserAnnotations(chatId, restore.browserAnnotations);
  } else {
    showErrorNoticeToast(
      displacedRestorationNotice(
        send.row.clientActionId,
        restore.content,
        EVICTED_SEND_FAILED_MESSAGE,
      ),
    );
  }
  releaseComposerContentImageRoots(imageRootsHolder(send));
  return restored;
}

/** {@link handBack}, for a failure nothing else has told the person about. */
function failSend(chatId: string, send: ParkedEvictedSend): void {
  if (!handBack(chatId, send)) return;
  reportableWarningToast(
    EVICTED_SEND_FAILED_MESSAGE,
    undefined,
    CHAT_ACTION_REPORT_CONTEXT,
  );
}

/**
 * A chat tile's road for a message to a chat its host dropped the records of
 * (cold eviction). The pool serving the transcript takes no message, so the
 * message is parked and drawn as a pending send, and the host is asked for the
 * chat (`epic.hydrateChat`). The host's answer is the release: the tile holds
 * the chat on its host (`holdChatOnItsHost`) whatever the witness still reads,
 * its session moves there, and the session view sends the parked messages by
 * the ordinary road once that session can act (`take`). The hold ends when the
 * witness stops reading the chat at rest, or the tile closes.
 *
 * Held by the tile above its session, so a parked message outlives the
 * session's move from the pool to the host. The composer has cleared by then,
 * so this hook is the message's only copy until it is dispatched: its images
 * stay rooted, and a refusal, a tile that closes and a page that goes away
 * each put it back. A message fails like any failed send: its text returns and
 * a toast says so. There is no timer: a host that goes away after answering
 * reads offline on the tile, and the message goes when it returns.
 */
export function useEvictedChatSend(input: {
  readonly epicId: string;
  readonly chatId: string;
  /** The chat's own host: the tab's host. */
  readonly hostId: string;
  /** `useChatEvictionServing`'s two answers. */
  readonly served: boolean;
  readonly held: boolean;
}): EvictedChatSend {
  const { epicId, chatId, hostId, served, held } = input;
  const { mutate: hydrate } = useChatHydrateMutation({
    client: useHostClientForHostId(hostId),
    hostId,
    chatId,
  });
  const parkedRef = useRef<readonly ParkedEvictedSend[]>([]);
  const releaseHoldRef = useRef<(() => void) | null>(null);
  const [parked, setParked] = useState<readonly ParkedEvictedSend[]>([]);
  const [ready, setReady] = useState(false);
  // Set by a refusal, cleared once the host holds the chat again: a chat the
  // host refused a message for is asked about before the next one.
  const [askFirst, setAskFirst] = useState(false);

  const replaceParked = useCallback((next: readonly ParkedEvictedSend[]) => {
    parkedRef.current = next;
    setParked(next);
    if (next.length === 0) setReady(false);
  }, []);

  const refuse = useCallback(() => {
    setAskFirst(true);
  }, []);

  const park = useCallback(
    (message: ChatComposerSubmitInput, sender: UserMessageSender): void => {
      const send = parkedSend(message, sender);
      holdComposerContentImageRoots(imageRootsHolder(send), message.content);
      const waiting = parkedRef.current;
      replaceParked([...waiting, send]);
      // The first message's request answers for every message behind it.
      if (waiting.length > 0) return;
      hydrate(
        { epicId, chatId },
        {
          onSuccess: () => {
            if (parkedRef.current.length === 0) return;
            if (releaseHoldRef.current === null) {
              releaseHoldRef.current = holdChatOnItsHost({
                hostId,
                epicId,
                chatId,
              });
            }
            setAskFirst(false);
            setReady(true);
          },
          onError: (error) => {
            const sends = parkedRef.current;
            replaceParked([]);
            // The mutation's own toast says the send failed.
            for (const failed of sends) handBack(chatId, failed);
            if (isEvictedChatRefusal(error.code)) refuse();
          },
        },
      );
    },
    [chatId, epicId, hostId, hydrate, refuse, replaceParked],
  );

  const take = useCallback((): readonly ParkedEvictedSend[] => {
    const sends = parkedRef.current;
    replaceParked([]);
    return sends;
  }, [replaceParked]);

  const settle = useCallback(
    (send: ParkedEvictedSend, accepted: boolean): void => {
      if (accepted) releaseComposerContentImageRoots(imageRootsHolder(send));
      else failSend(chatId, send);
    },
    [chatId],
  );

  // The hold ends once the witness alone no longer reads the chat at rest.
  // Re-checked when a hold starts too, since the witness may have caught up
  // before the host answered.
  useEffect(() => {
    if (held) return;
    releaseHoldRef.current?.();
    releaseHoldRef.current = null;
  }, [held, ready]);

  // A closed tile cannot send what it parked, and neither can a page that is
  // going away: the message goes back to the draft, which outlives both. Its
  // hold ends with the tile.
  useEffect(() => {
    const handBackParked = (): void => {
      const sends = parkedRef.current;
      replaceParked([]);
      for (const failed of sends) failSend(chatId, failed);
    };
    window.addEventListener("pagehide", handBackParked);
    return () => {
      window.removeEventListener("pagehide", handBackParked);
      handBackParked();
      releaseHoldRef.current?.();
      releaseHoldRef.current = null;
    };
  }, [chatId, replaceParked]);

  const parks = served || askFirst || parked.length > 0;
  return useMemo(
    () => ({ parks, served, parked, ready, park, take, settle, refuse }),
    [parks, served, parked, ready, park, take, settle, refuse],
  );
}
