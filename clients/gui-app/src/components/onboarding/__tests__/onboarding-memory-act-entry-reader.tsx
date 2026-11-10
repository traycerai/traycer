import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConfigAgentMemoriesResponse } from "@traycer/protocol/host/config/schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";

/**
 * A second reader of the cache entry the act reads, as Settings → Agent
 * memories is: same method, no cache identity, the same client. A test mounts
 * it once the tour has moved on and sees what the entry gives a later reader.
 */
export function EntryReaderSlot(props: {
  readonly onMount: (mount: ((hostId: string) => void) | null) => void;
  readonly onAnswer: (answer: ConfigAgentMemoriesResponse | null) => void;
}): ReactNode {
  const [mounted, setMounted] = useState<string | null>(null);
  const { onMount } = props;
  useEffect(() => {
    onMount((hostId) => setMounted(hostId));
    return () => onMount(null);
  }, [onMount]);
  return mounted === null ? null : (
    <EntryReader hostId={mounted} onAnswer={props.onAnswer} />
  );
}

function EntryReader(props: {
  readonly hostId: string;
  readonly onAnswer: (answer: ConfigAgentMemoriesResponse | null) => void;
}): ReactNode {
  const binding = useHostBinding();
  const { hostId } = props;
  const client = useMemo(
    () =>
      binding === null
        ? null
        : binding.hostClient.createRequesterForHostId(hostId),
    [binding, hostId],
  );
  const read = useHostQuery<HostRpcRegistry, "config.agentMemories.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.agentMemories.get",
    params: {},
    // The app's client keeps a read fresh for a minute (`createAppQueryClient`);
    // the test client's default of none would refetch whatever the act left.
    options: { enabled: true, staleTime: 60_000 },
  });
  const { onAnswer } = props;
  const answer = read.data ?? null;
  useEffect(() => {
    onAnswer(answer);
  }, [answer, onAnswer]);
  return null;
}
