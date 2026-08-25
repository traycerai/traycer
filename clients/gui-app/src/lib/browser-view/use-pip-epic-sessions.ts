/**
 * React binding for the active PiP's remote-host inventory.
 *
 * The caller supplies only the distinct non-canvas hosts named by the current
 * and pending PiP targets. A directory change retries a target that was not
 * registered when first requested; an open durable transport reconnects
 * itself thereafter. There is no timer and no epic-wide host scan.
 */
import { useEffect, useRef, useState } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { useHostDirectory } from "@/lib/host";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { RemotePipSessionsManager } from "./pip-epic-sessions";

const EMPTY_REMOTE_SESSIONS: readonly BrowserSessionInfo[] = [];

export function useRemotePipSessions(
  epicId: string,
  hostIds: readonly string[],
): readonly BrowserSessionInfo[] {
  const openTransport = useDurableStreamTransportFactory();
  const directory = useHostDirectory();
  const managerRef = useRef<RemotePipSessionsManager | null>(null);
  const [items, setItems] = useState<readonly BrowserSessionInfo[]>(
    EMPTY_REMOTE_SESSIONS,
  );
  const active = hostIds.length > 0;

  useEffect(() => {
    if (!active) {
      managerRef.current = null;
      setItems(EMPTY_REMOTE_SESSIONS);
      return;
    }
    let current = true;
    const manager = new RemotePipSessionsManager(
      epicId,
      openTransport,
      (nextItems) => {
        if (current) setItems(nextItems);
      },
    );
    manager.attach();
    managerRef.current = manager;
    return () => {
      current = false;
      if (managerRef.current === manager) managerRef.current = null;
      manager.dispose();
    };
  }, [active, epicId, openTransport]);

  useEffect(() => {
    if (!active) return;
    const reconcile = (): void => {
      managerRef.current?.setHostIds(hostIds);
    };
    reconcile();
    const subscription = directory.onChange(reconcile);
    return () => {
      subscription.dispose();
    };
  }, [active, directory, epicId, hostIds, openTransport]);
  return items;
}
