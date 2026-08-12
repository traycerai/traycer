import { useEffect, useRef, type ReactNode } from "react";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import { useLandingTerminalKill } from "@/components/home/terminal-panel/use-landing-terminal-kill-mutation";
import {
  isHostReachable,
  type HostAvailability,
} from "@traycer-clients/shared/host-client/host-directory";

/**
 * Drains durable landing-terminal close tombstones when their bound host
 * returns. This lives above the router so leaving the landing page cannot
 * strand an offline-close shell until the user happens to return home.
 */
export function LandingTerminalTombstoneRecoveryBridge(): ReactNode {
  const directory = useHostDirectoryList();
  const pendingKills = useLandingTerminalStore((state) => state.pendingKills);
  const kill = useLandingTerminalKill();
  const killRef = useRef(kill);
  const availabilityRef = useRef<ReadonlyMap<string, HostAvailability>>(
    new Map(),
  );

  useEffect(() => {
    killRef.current = kill;
  }, [kill]);

  useEffect(() => {
    const entries = directory.data ?? [];
    const currentAvailability = new Map(
      entries.map((entry) => [entry.hostId, entry.status]),
    );
    const previousAvailability = availabilityRef.current;
    availabilityRef.current = currentAvailability;

    if (pendingKills.length === 0) return;

    for (const pending of pendingKills) {
      const status = currentAvailability.get(pending.hostId);
      const previous = previousAvailability.get(pending.hostId);
      // The edge is "became REACHABLE", not "became available". The kill needs
      // a dialable host, which `busy` is - and after int #48 a host recovering
      // from a stall goes unavailable -> busy and may sit there, so an
      // `=== "available"` edge would simply never fire and strand the
      // tombstone with the host terminal still alive.
      if (
        status !== undefined &&
        isHostReachable(status) &&
        (previous === undefined || !isHostReachable(previous))
      ) {
        killRef.current.mutate(pending);
      }
    }
  }, [directory.data, pendingKills]);

  return null;
}
