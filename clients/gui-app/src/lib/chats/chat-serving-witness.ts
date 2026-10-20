import { createContext, use, useCallback, useSyncExternalStore } from "react";
import {
  chatServingHostId,
  readProcessHostRpcTierPlan,
  type ChatServingKey,
  type ChatServingWitness,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";

/**
 * The per-chat readiness witness the live-versus-at-rest switch consumes.
 * `null` until one is provided (the readiness work publishes it): with none,
 * every chat is served by its own host, as before.
 */
export const ChatServingWitnessContext =
  createContext<ChatServingWitness | null>(null);

/**
 * The host id a chat's transcript stream is opened on (`chatServingHostId`),
 * re-read whenever the witness reports a change.
 */
export function useChatServingHostId(chat: ChatServingKey): string {
  const witness = use(ChatServingWitnessContext);
  const chatHost = useHostDirectoryEntry(chat.hostId);
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      witness === null ? () => undefined : witness.subscribe(listener),
    [witness],
  );
  // The verdict is read here only to subscribe to it: a change re-renders,
  // and the pure decision below reads it again.
  useSyncExternalStore(subscribe, () =>
    witness === null ? null : witness.verdictFor(chat),
  );
  return chatServingHostId(
    chat,
    chatHost,
    witness,
    readProcessHostRpcTierPlan(),
  );
}
