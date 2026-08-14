import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { isRelayFuseRecoveryCandidate } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";
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
  // (`isRelayFuseRecoveryCandidate`). There the endpoint is non-null because a
  // recovery dial is PERMITTED, not because the host is there - recording that
  // speculative permission as `true` made a close-during-grace followed by a
  // genuine offline -> connectable recovery a `true -> true` non-edge, so the
  // kill never re-fired and the tombstoned PTY outlived its tab until
  // relaunch. `indeterminate` keeps recording `true` (the paragraph above),
  // because unlike a fuse-window `offline` it may never resolve.
  //
  // A READY remote session overrides that exclusion: it is proof the host is
  // actually attached, not speculation - the recovery dial the fuse window
  // kept open has SUCCEEDED. If the registry stays `offline` for the rest of
  // the credential-plane incident, that session is the only evidence of the
  // recovery there will be, and it is also the very route the kill travels.
  // The session cache is pull-only, so the subscription below - not the
  // directory - is what re-runs this effect when a session becomes ready.
  const dialableRef = useRef<ReadonlyMap<string, boolean>>(new Map());
  const hostIds = useMemo(
    () => (directory.data ?? []).map((entry) => entry.hostId),
    [directory.data],
  );
  const hasReadySessionFor = useRemoteSessionsPollReadiness(hostIds);

  useEffect(() => {
    killRef.current = kill;
  }, [kill]);

  useEffect(() => {
    const entries = directory.data ?? [];
    const currentDialable = new Map(
      entries.map((entry) => {
        const hasReadySession = hasReadySessionFor(entry.hostId);
        return [
          entry.hostId,
          dialableHostEndpointFor(entry, hasReadySession) !== null &&
            (hasReadySession || !isRelayFuseRecoveryCandidate(entry)),
        ];
      }),
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
  }, [directory.data, pendingKills, hasReadySessionFor]);

  return null;
}
