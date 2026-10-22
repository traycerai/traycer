import { useEffect, useState, type ReactNode } from "react";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { usePoolTierStreamClient } from "@/hooks/host/use-pool-tier";
import { ChatServingWitnessContext } from "@/lib/chats/chat-serving-witness";
import { PoolChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Publishes the chat serving witness for every chat tile below it: the
 * server's per-chat state, read over the pool's `chat.serving.subscribe`.
 *
 * None in a build with no pool, and none once the pool's handshake says it
 * does not serve the stream: every chat is then served by its own host, as
 * before the witness existed.
 */
export function ChatServingWitnessProvider(props: {
  readonly children: ReactNode;
}) {
  const [witness] = useState(() => new PoolChatServingWitness());
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const binding = useSurfaceHostStreamBinding(null);
  const streamClient = usePoolTierStreamClient(
    binding?.wsStreamClient ?? null,
    userId,
  );
  const hasPool = readProcessHostRpcTierPlan().pool !== null;
  const poolStreamClient = hasPool ? streamClient : null;
  const support = useStreamMethodSupportFor(
    poolStreamClient,
    "chat.serving.subscribe",
  );
  useEffect(() => {
    witness.setStreamClient(poolStreamClient);
  }, [witness, poolStreamClient]);
  useEffect(() => () => witness.dispose(), [witness]);
  const provided = hasPool && support !== "unsupported" ? witness : null;
  return (
    <ChatServingWitnessContext value={provided}>
      {props.children}
    </ChatServingWitnessContext>
  );
}
