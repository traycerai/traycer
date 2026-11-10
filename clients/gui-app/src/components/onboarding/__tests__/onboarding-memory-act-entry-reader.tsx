import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConfigAgentMemoriesResponse } from "@traycer/protocol/host/config/schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";

/**
 * Settings → Agent memories' reader of the setting: same method, no cache
 * identity (the act reads under its own), the client of the host it names. A test mounts
 * it once the tour has moved on and sees what the entry gives a later reader.
 */
export function EntryReaderSlot(props: {
  readonly onMount: (mount: ((hostId: string | null) => void) | null) => void;
  readonly onAnswer: (answer: ConfigAgentMemoriesResponse | null) => void;
}): ReactNode {
  const [mounted, setMounted] = useState<string | null>(null);
  const { onMount } = props;
  useEffect(() => {
    onMount(setMounted);
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
