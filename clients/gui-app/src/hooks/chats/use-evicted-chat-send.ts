import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useChatHydrateMutation } from "@/hooks/chats/use-chat-hydrate-mutation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { holdChatOnItsHost } from "@/lib/chats/chat-continuing-on-host";
import {
  evictedChatRefusalOfCode,
  type EvictedChatRefusal,
} from "@/lib/chats/evicted-chat-refusal";
import {
  EMPTY_COMPOSER_DRAFT,
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

/** What the line above the composer says about an evicted chat. */
export type EvictedChatLineKind = "hydrating" | EvictedChatRefusal;

/** A message held until the chat's host holds the chat again. */
export interface ParkedEvictedSend {
  readonly input: ChatComposerSubmitInput;
  /** Settles the composer's submit: `true` clears it, `false` keeps the draft. */
  readonly settle: (accepted: boolean) => void;
}

export interface EvictedChatSend {
  /**
   * Whether a message asks the chat's host to bring the chat back before it
   * is sent: while the pool serves the chat because the host dropped its
   * records, and after the host refused a message for that reason.
   */
  readonly parks: boolean;
  /** Whether the pool serves the chat; a parked message waits until it does not. */
  readonly served: boolean;
  readonly line: EvictedChatLineKind | null;
  /** Whether the host holds the chat again, so the parked message may go. */
  readonly ready: boolean;
  /**
   * Parks a message and asks the host for the chat. The promise is the
   * composer's: the draft stays while it is pending and after `false`.
   * `false` at once when a message is already parked.
   */
  readonly park: (input: ChatComposerSubmitInput) => Promise<boolean> | false;
  /** Takes the parked message to send it, which ends the hydrating line. */
  readonly take: () => ParkedEvictedSend | null;
  /** A refusal the host sent on a message's ack instead of the request. */
  readonly refuse: (refusal: EvictedChatRefusal) => void;
}

interface StandingRefusal {
  readonly refusal: EvictedChatRefusal;
  /**
   * The draft's revision once the refused message was back in the composer.
   * Any edit moves the revision, and the line ends with it.
   */
  readonly draftRevision: number;
}

type ParkPhase = "idle" | "hydrating" | "ready";

/**
 * The hydrating line while a message is parked, else a refusal while the
 * draft it came back as is unedited.
 */
function evictedChatLine(
  phase: ParkPhase,
  standing: StandingRefusal | null,
  draftRevision: number,
): EvictedChatLineKind | null {
  if (phase !== "idle") return "hydrating";
  if (standing === null || standing.draftRevision !== draftRevision) {
    return null;
  }
  return standing.refusal;
}

/**
 * A chat tile's road for a message to a chat its host dropped the records of
 * (cold eviction). The pool serving the transcript takes no message, so the
 * message is parked, the host is asked for the chat (`epic.hydrateChat`) and
 * the hydrating line shows. The host's answer is the release: the tile holds
 * the chat on its host (`holdChatOnItsHost`) whatever the witness still
 * reads, its session moves there, and the session view sends the parked
 * message by the ordinary road once that session can act (`take`). The hold
 * ends when the witness stops reading the chat at rest, or the tile closes. A
 * typed refusal drops the message back into the composer as the draft and
 * the line says why.
 *
 * Held by the tile above its session, so the parked message outlives the
 * session's move from the pool to the host. A refusal stands until the draft
 * is edited or the host's connection comes back, and a new attempt asks the
 * host again; there is no timer.
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
  const parkedRef = useRef<ParkedEvictedSend | null>(null);
  const releaseHoldRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<ParkPhase>("idle");
  const [standing, setStanding] = useState<StandingRefusal | null>(null);
  // Set by a refusal, cleared once the host holds the chat again: a chat the
  // host refused a message for is asked about before the next one.
  const [askFirst, setAskFirst] = useState(false);
  const draftRevision = useComposerDraftStore(
    (state) => (state.drafts[chatId] ?? EMPTY_COMPOSER_DRAFT).revision,
  );
  const ownerStatus = useHostReachability(hostId).status;
  const [seenOwnerStatus, setSeenOwnerStatus] = useState(ownerStatus);
  if (ownerStatus !== seenOwnerStatus) {
    setSeenOwnerStatus(ownerStatus);
    if (ownerStatus === "reachable") setStanding(null);
  }

  const refuse = useCallback(
    (refusal: EvictedChatRefusal) => {
      setAskFirst(true);
      setStanding({
        refusal,
        draftRevision: readComposerDraftSnapshot(chatId).revision,
      });
    },
    [chatId],
  );

  const park = useCallback(
    (message: ChatComposerSubmitInput): Promise<boolean> | false => {
      if (parkedRef.current !== null) return false;
      let settle: (accepted: boolean) => void = () => undefined;
      const accepted = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      parkedRef.current = { input: message, settle };
      setStanding(null);
      setPhase("hydrating");
      hydrate(
        { epicId, chatId },
        {
          onSuccess: () => {
            if (parkedRef.current === null) return;
            releaseHoldRef.current ??= holdChatOnItsHost({
              hostId,
              epicId,
              chatId,
            });
            setAskFirst(false);
            setPhase("ready");
          },
          onError: (error) => {
            const parked = parkedRef.current;
            parkedRef.current = null;
            setPhase("idle");
            parked?.settle(false);
            const refusal = evictedChatRefusalOfCode(error.code);
            if (refusal !== null) refuse(refusal);
          },
        },
      );
      return accepted;
    },
    [chatId, epicId, hostId, hydrate, refuse],
  );

  const take = useCallback((): ParkedEvictedSend | null => {
    const parked = parkedRef.current;
    parkedRef.current = null;
    setPhase("idle");
    return parked;
  }, []);

  // The hold ends once the witness alone no longer reads the chat at rest.
  // Re-checked when a hold starts too, since the witness may have caught up
  // before the host answered.
  useEffect(() => {
    if (held) return;
    releaseHoldRef.current?.();
    releaseHoldRef.current = null;
  }, [held, phase]);

  // A tile closed with a message parked hands the draft back, and its hold
  // ends.
  useEffect(
    () => () => {
      const parked = parkedRef.current;
      parkedRef.current = null;
      parked?.settle(false);
      releaseHoldRef.current?.();
      releaseHoldRef.current = null;
    },
    [],
  );

  const line = evictedChatLine(phase, standing, draftRevision);
  const parks = served || askFirst;
  const ready = phase === "ready";
  return useMemo(
    () => ({ parks, served, line, ready, park, take, refuse }),
    [parks, served, line, ready, park, take, refuse],
  );
}
