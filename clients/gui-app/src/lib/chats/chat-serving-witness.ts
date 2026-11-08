import {
  createContext,
  use,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  chatServingHostId,
  isMachineHostDirectoryEntry,
  isTeamSandboxHostDirectoryEntry,
  readProcessHostRpcTierPlan,
  type ChatServingKey,
  type ChatServingVerdict,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import { useEnvironmentArmChats } from "@/hooks/environment/use-environment-arms";
import { useChatContinuingOnItsHost } from "@/lib/chats/chat-continuing-on-host";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import type { RetainingChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * The per-chat readiness witness the live-versus-at-rest switch consumes.
 * `null` in a build with no pool: every chat is then served by its own host,
 * as before.
 */
export const ChatServingWitnessContext =
  createContext<RetainingChatServingWitness | null>(null);

/**
 * Why the witness is asked about a chat. Every other chat is served by its own
 * host and opens no witness stream.
 *
 * - `team-sandbox` - a team sandbox's chat: at rest while the sandbox is not
 *   awake. The open waits for the server's first state.
 * - `evicted` - a machine's chat (`isMachineHostDirectoryEntry`) that the
 *   machine serving the epic's list says it dropped the records of
 *   (`evicted`, `epic.listChatRecords@1.4`). The open waits for the first
 *   state too: the machine cannot serve the chat.
 * - `cross-host` - a machine's chat in an epic another host serves, whose list
 *   cannot say whether the chat's own machine dropped it. The open does NOT
 *   wait: the chat stays on its machine until the witness says it is at rest,
 *   because a chat the pool has no row for yet (one not published) never gets
 *   a first state.
 *
 * A personal sandbox's chat is never asked about, so it stays on its sandbox.
 *
 * A machine's chat its host has brought back stays on the machine while the
 * witness still reads it at rest (`holdChatOnItsHost`): the host's answer is
 * the release, and the server's fact is cleared on its own later.
 */
type ChatServingWitnessArm = "team-sandbox" | "evicted" | "cross-host";

/**
 * Whether the open epic's list says its serving host dropped `chat`'s
 * records. Reads that epic's store only when the chat is in it, since the
 * list speaks about no other chat.
 */
function useListedEvicted(
  listedStore: OpenEpicStoreHandle["store"] | null,
  chatId: string,
): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      listedStore === null ? () => undefined : listedStore.subscribe(onChange),
    [listedStore],
  );
  const read = (): boolean =>
    listedStore?.getState().evictedChatIds.has(chatId) ?? false;
  return useSyncExternalStore(subscribe, read, read);
}

function useChatServingWitnessArm(
  chat: ChatServingKey,
): ChatServingWitnessArm | null {
  const chatHost = useHostDirectoryEntry(chat.hostId);
  // The epic's list is the open epic's, served by its session's host: it
  // speaks about this chat only when the chat is in that epic.
  const openEpic = useMaybeOpenEpicHandle();
  const listedStore =
    openEpic !== null && openEpic.epicId === chat.epicId
      ? openEpic.store
      : null;
  const listHostId = useEpicSessionHostId();
  const listedEvicted = useListedEvicted(listedStore, chat.chatId);
  if (chatHost === null) return null;
  if (isTeamSandboxHostDirectoryEntry(chatHost)) return "team-sandbox";
  if (
    listedStore === null ||
    listHostId === null ||
    !isMachineHostDirectoryEntry(chatHost)
  )
    return null;
  if (chat.hostId !== listHostId) return "cross-host";
  return listedEvicted ? "evicted" : null;
}

interface ApplicableWitness {
  readonly witness: RetainingChatServingWitness;
  readonly arm: ChatServingWitnessArm;
}

/**
 * The witness, when it applies to `chat` (see {@link ChatServingWitnessArm}).
 * Keeps the chat's state subscribed while the caller is mounted.
 */
function useApplicableWitness(chat: ChatServingKey): ApplicableWitness | null {
  const witness = use(ChatServingWitnessContext);
  const arm = useChatServingWitnessArm(chat);
  const applicable =
    witness !== null && readProcessHostRpcTierPlan().pool !== null
      ? witness
      : null;
  const watched = applicable !== null && arm !== null ? applicable : null;
  const { hostId, epicId, chatId } = chat;
  useEffect(
    () => watched?.retain({ hostId, epicId, chatId }),
    [watched, hostId, epicId, chatId],
  );
  // A team host's chat is environment-owned, so its publication is the row
  // appearing in the environment arm. Until then the pool ends the witness's
  // stream `CHAT_NOT_VISIBLE`; the row's arrival reopens it, leaving a
  // healthy stream and every holder alone. A machine's chat needs neither:
  // an evicted one is published, and a cross-host one waits for no answer.
  const reopenOn = arm === "team-sandbox" ? watched : null;
  const published = useEnvironmentArmChats(
    reopenOn === null ? "" : epicId,
  ).some((row) => row.identity.chatId === chatId);
  useEffect(() => {
    if (published) reopenOn?.reopen({ hostId, epicId, chatId });
  }, [reopenOn, hostId, epicId, chatId, published]);
  return watched === null || arm === null ? null : { witness: watched, arm };
}

interface ChatServingReading {
  /** Why the witness is asked about the chat; `null` when it is not. */
  readonly arm: ChatServingWitnessArm | null;
  readonly serving: ChatServing | null;
}

function useChatServingReading(chat: ChatServingKey): ChatServingReading {
  const applicable = useApplicableWitness(chat);
  const witness = applicable?.witness ?? null;
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      witness === null ? () => undefined : witness.subscribe(listener),
    [witness],
  );
  const serving = useSyncExternalStore(subscribe, () =>
    witness === null ? null : witness.servingFor(chat),
  );
  return { arm: applicable?.arm ?? null, serving };
}

/** The server's published state for `chat`, re-read on every change. */
export function useChatServing(chat: ChatServingKey): ChatServing | null {
  return useChatServingReading(chat).serving;
}

function isMachineArm(arm: ChatServingWitnessArm | null): boolean {
  return arm === "evicted" || arm === "cross-host";
}

/**
 * Whether the peer {@link useChatServingHostId} names is decided: always for
 * a chat the witness is not asked about or only asked about across hosts, for
 * a machine's chat its host brought back, and for a team sandbox's or an
 * evicted chat once the server's first state arrived. A stream is opened only
 * on a decided peer, so opening a live chat never first subscribes on the
 * pool, and an evicted one never first subscribes on a machine that has
 * dropped its records.
 */
export function useChatServingSettled(chat: ChatServingKey): boolean {
  const reading = useChatServingReading(chat);
  const continuing = useChatContinuingOnItsHost(chat);
  return (
    reading.arm === null ||
    reading.arm === "cross-host" ||
    (continuing && isMachineArm(reading.arm)) ||
    reading.serving !== null
  );
}

interface ChatServingDecision {
  readonly arm: ChatServingWitnessArm | null;
  /** The verdict routing follows; `null` when the witness is not asked. */
  readonly verdict: ChatServingVerdict | null;
  /** The witness's own verdict, before a brought-back chat's hold. */
  readonly witnessVerdict: ChatServingVerdict | null;
}

/**
 * The witness's verdict for `chat` as a value, re-read whenever the witness
 * reports a change. Callers decide on this value and never on the witness,
 * whose identity does not move with its verdicts. A cross-host chat with no
 * answer yet reads as not asked, so it stays on its machine, and a machine's
 * chat its host brought back reads live (`holdChatOnItsHost`).
 */
function useChatServingDecision(chat: ChatServingKey): ChatServingDecision {
  const applicable = useApplicableWitness(chat);
  const witness = applicable?.witness ?? null;
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      witness === null ? () => undefined : witness.subscribe(listener),
    [witness],
  );
  const raw = useSyncExternalStore(subscribe, () =>
    witness === null ? null : witness.verdictFor(chat),
  );
  const arm = applicable?.arm ?? null;
  const continuing = useChatContinuingOnItsHost(chat);
  const witnessVerdict = arm === "cross-host" && raw === "unknown" ? null : raw;
  return {
    arm,
    verdict: continuing && isMachineArm(arm) ? "live" : witnessVerdict,
    witnessVerdict,
  };
}

/**
 * The host id a chat's transcript stream is opened on (`chatServingHostId`),
 * re-read whenever the witness reports a change.
 */
export function useChatServingHostId(chat: ChatServingKey): string {
  const { verdict } = useChatServingDecision(chat);
  return chatServingHostId(chat, verdict, readProcessHostRpcTierPlan());
}

/** Where a machine's chat is served, and where the witness alone would serve it. */
export interface ChatEvictionServing {
  /**
   * The pool serves the chat because its machine dropped the chat's records.
   * A message to it then asks the machine to bring them back first
   * (`useEvictedChatSend`), since the pool takes none.
   */
  readonly served: boolean;
  /**
   * The witness alone still reads the chat at rest. A hold that brought the
   * chat back is released once this is false: the witness has caught up, or
   * no longer speaks about the chat.
   */
  readonly held: boolean;
}

export function useChatEvictionServing(
  chat: ChatServingKey,
): ChatEvictionServing {
  const { arm, verdict, witnessVerdict } = useChatServingDecision(chat);
  const plan = readProcessHostRpcTierPlan();
  const machine = isMachineArm(arm);
  return {
    served: machine && chatServingHostId(chat, verdict, plan) === POOL_HOST_ID,
    held:
      machine && chatServingHostId(chat, witnessVerdict, plan) === POOL_HOST_ID,
  };
}
