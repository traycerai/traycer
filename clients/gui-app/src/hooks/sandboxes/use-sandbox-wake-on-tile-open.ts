import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { isSandboxAsleep } from "@traycer-clients/shared/host-client/sandbox-control";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostBinding } from "@/lib/host";
import { startSandboxWake } from "@/lib/sandboxes/sandbox-wake";

/**
 * Wakes a tile's sandbox host. Mounted only for a tile that was OPENED in this
 * session (`SandboxWakeOnTileOpen` gates on the open provenance), never for
 * one a layout restored: opening a tab is the inbound action the core flows
 * name, while a restore (or a session's reconnect loop) waking every sandbox a
 * canvas ever showed would keep forgotten machines awake on the meter.
 *
 * Fires at most once per mount, decided on the host's FIRST directory entry:
 * only when that entry says the sandbox is suspended, stopped or frozen, through the same wake a host picker's pick
 * starts (`startSandboxWake`), so a tab opened on a host a pick is
 * already waking joins that wake. A frozen sandbox is refused at once with the
 * typed `SANDBOX_FROZEN` refusal, instead of a dial that would wait out relay
 * timeouts.
 */
export function useSandboxWakeForOpenedTile(hostId: string): void {
  const entry = useHostDirectoryEntry(hostId);
  const facts =
    entry !== null && isRemoteHostDirectoryEntry(entry) ? entry.sandbox : null;
  const needsWake =
    facts !== null && (facts.frozen || isSandboxAsleep(facts.state));

  const binding = useHostBinding();
  const queryClient = useQueryClient();
  // One shot, spent on the FIRST directory answer for the host, whatever it
  // says. The open is the inbound action; a sandbox that was awake then and
  // idles to `suspended` later was suspended by its idle timer, and waking it
  // again for a tab left open would defeat the suspension and keep the meter
  // running for a tab nobody is using.
  const firedRef = useRef(false);
  const known = entry !== null;
  useEffect(() => {
    if (!known || firedRef.current) return;
    firedRef.current = true;
    if (needsWake) startSandboxWake(queryClient, binding, hostId);
  }, [binding, hostId, known, needsWake, queryClient]);
}
