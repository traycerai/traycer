import {
  createContext,
  use,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react";
import {
  chatServingHostId,
  isTeamSandboxHostDirectoryEntry,
  readProcessHostRpcTierPlan,
  type ChatServingKey,
  type ChatServingVerdict,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import { useEnvironmentArmChats } from "@/hooks/environment/use-environment-arms";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import type { RetainingChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";

/**
 * The per-chat readiness witness the live-versus-at-rest switch consumes.
 * `null` in a build with no pool: every chat is then served by its own host,
 * as before.
 */
export const ChatServingWitnessContext =
  createContext<RetainingChatServingWitness | null>(null);

/**
 * The witness, when it applies to `chat`: only a team sandbox's chat ever
 * moves between its host and the pool (`chatServingHostId`), so only those
 * are watched. Keeps the chat's state subscribed while the caller is mounted.
 */
function useApplicableWitness(
  chat: ChatServingKey,
): RetainingChatServingWitness | null {
  const witness = use(ChatServingWitnessContext);
  const chatHost = useHostDirectoryEntry(chat.hostId);
  const applicable =
    witness !== null &&
    readProcessHostRpcTierPlan().pool !== null &&
    chatHost !== null &&
    isTeamSandboxHostDirectoryEntry(chatHost)
      ? witness
      : null;
  const { hostId, epicId, chatId } = chat;
  useEffect(
    () => applicable?.retain({ hostId, epicId, chatId }),
    [applicable, hostId, epicId, chatId],
  );
  // A team host's chat is environment-owned, so its publication is the row
  // appearing in the environment arm. Until then the pool ends the witness's
  // stream `CHAT_NOT_VISIBLE`; the row's arrival reopens it, leaving a
  // healthy stream and every holder alone.
  const published = useEnvironmentArmChats(
    applicable === null ? "" : epicId,
  ).some((row) => row.identity.chatId === chatId);
  useEffect(() => {
    if (published) applicable?.reopen({ hostId, epicId, chatId });
  }, [applicable, hostId, epicId, chatId, published]);
  return applicable;
}

interface ChatServingReading {
  /** Whether the witness applies to the chat (a team sandbox's, with a pool). */
  readonly applies: boolean;
  readonly serving: ChatServing | null;
}

function useChatServingReading(chat: ChatServingKey): ChatServingReading {
  const witness = useApplicableWitness(chat);
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      witness === null ? () => undefined : witness.subscribe(listener),
    [witness],
  );
  const serving = useSyncExternalStore(subscribe, () =>
    witness === null ? null : witness.servingFor(chat),
  );
  return { applies: witness !== null, serving };
}

/** The server's published state for `chat`, re-read on every change. */
export function useChatServing(chat: ChatServingKey): ChatServing | null {
  return useChatServingReading(chat).serving;
}

/**
 * Whether the peer {@link useChatServingHostId} names is decided: always for
 * a chat the witness does not apply to, and for a team sandbox's chat once the
 * server's first state arrived. A stream is opened only on a decided peer, so
 * opening a live chat never first subscribes on the pool.
 */
export function useChatServingSettled(chat: ChatServingKey): boolean {
  const reading = useChatServingReading(chat);
  return !reading.applies || reading.serving !== null;
}

/**
 * The witness's verdict for `chat` as a value, `null` in a build with no pool,
 * re-read whenever the witness reports a change. Callers decide on this value
 * and never on the witness, whose identity does not move with its verdicts.
 */
function useChatServingVerdict(
  chat: ChatServingKey,
): ChatServingVerdict | null {
  const witness = use(ChatServingWitnessContext);
  // Retains the chat while mounted, so the witness keeps hearing its state.
  useChatServing(chat);
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      witness === null ? () => undefined : witness.subscribe(listener),
    [witness],
  );
  return useSyncExternalStore(subscribe, () =>
    witness === null ? null : witness.verdictFor(chat),
  );
}

/**
 * The host id a chat's transcript stream is opened on (`chatServingHostId`),
 * re-read whenever the witness reports a change.
 */
export function useChatServingHostId(chat: ChatServingKey): string {
  const chatHost = useHostDirectoryEntry(chat.hostId);
  const verdict = useChatServingVerdict(chat);
  return chatServingHostId(
    chat,
    chatHost,
    verdict,
    readProcessHostRpcTierPlan(),
  );
}
