import { useEffect, useState, type ReactNode } from "react";
import type { ConfigAgentMemoriesResponse } from "@traycer/protocol/host/config/schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useOptionalHostClient, type HostRpcRegistry } from "@/lib/host";

/**
 * A second reader of the cache entry the act reads, as Settings → Agent
 * memories is: same method, no cache identity, the same client. A test mounts
 * it once the tour has moved on and sees what the entry gives a later reader.
 */
export function EntryReaderSlot(props: {
  readonly onMount: (mount: (() => void) | null) => void;
  readonly onAnswer: (answer: ConfigAgentMemoriesResponse | null) => void;
}): ReactNode {
  const [mounted, setMounted] = useState(false);
  const { onMount } = props;
  useEffect(() => {
    onMount(() => setMounted(true));
    return () => onMount(null);
  }, [onMount]);
  return mounted ? <EntryReader onAnswer={props.onAnswer} /> : null;
}

function EntryReader(props: {
  readonly onAnswer: (answer: ConfigAgentMemoriesResponse | null) => void;
}): ReactNode {
  const client = useOptionalHostClient();
  const read = useHostQuery<HostRpcRegistry, "config.agentMemories.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.agentMemories.get",
    params: {},
    options: { enabled: true },
  });
  const { onAnswer } = props;
  const answer = read.data ?? null;
  useEffect(() => {
    onAnswer(answer);
  }, [answer, onAnswer]);
  return null;
}
