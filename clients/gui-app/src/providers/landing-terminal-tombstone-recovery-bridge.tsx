import { useEffect, useRef, type ReactNode } from "react";
import { isRelayFuseRecoveryCandidate } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import { useLandingTerminalKill } from "@/components/home/terminal-panel/use-landing-terminal-kill-mutation";

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
  // Coarse, through the canonical rule. The edge this watches is "a route to
  // that host exists again", because what it does on that edge is send an RPC —
  // there is no copy here and nobody sees this. Asking `dialableHostEndpoint`
  // rather than the bit keeps it agreeing with the layer that will carry the
  // kill: an `indeterminate` host is dialable, so the tombstone drains and the
  // mutation either lands or fails on its own evidence, instead of waiting
  // forever on a liveness read that may never come back.
  //
  // It is also why the edge is "became DIALABLE" rather than "became
  // available": a host recovering from a stall goes unavailable -> busy and may
  // sit there, and busy is dialable, so an `=== "available"` edge would simply
  // never fire and would strand the tombstone with the host terminal alive.
  //
  // One dial-permission state is deliberately EXCLUDED from the recorded bit:
  // a registry-`offline` host inside the relay-fuse window
  // (`isRelayFuseRecoveryCandidate`). There `dialableHostEndpoint` is non-null
  // because a recovery dial is PERMITTED, not because the host is there -
  // recording that speculative permission as `true` made a close-during-grace
  // followed by a genuine offline -> connectable recovery a `true -> true`
  // non-edge, so the kill never re-fired and the tombstoned PTY outlived its
  // tab until relaunch. `indeterminate` keeps recording `true` (the paragraph
  // above), because unlike a fuse-window `offline` it may never resolve.
  const dialableRef = useRef<ReadonlyMap<string, boolean>>(new Map());

  useEffect(() => {
    killRef.current = kill;
  }, [kill]);

  useEffect(() => {
    const entries = directory.data ?? [];
    const currentDialable = new Map(
      entries.map((entry) => [
        entry.hostId,
        dialableHostEndpoint(entry) !== null &&
          !isRelayFuseRecoveryCandidate(entry),
      ]),
    );
    const previousDialable = dialableRef.current;
    dialableRef.current = currentDialable;

    if (pendingKills.length === 0) return;

    for (const pending of pendingKills) {
      if (
        currentDialable.get(pending.hostId) === true &&
        previousDialable.get(pending.hostId) !== true
      ) {
        killRef.current.mutate(pending);
      }
    }
  }, [directory.data, pendingKills]);

  return null;
}
