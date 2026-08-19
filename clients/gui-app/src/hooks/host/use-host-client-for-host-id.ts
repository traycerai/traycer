import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  useHostClient,
  useHostRuntimeClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

/**
 * Resolves the `HostClient` for an explicit host id captured elsewhere (a
 * tab's bound host threaded through as a plain id, a fork dialog's fixed
 * host). `null` follows the app-wide effective host; every explicit id
 * receives a pinned requester, including when it currently matches that
 * host. This prevents a fixed-host caller from silently moving when the
 * effective host changes before its next render. Every surface that
 * must agree on "which host does this id resolve to" (a tab's own consumers
 * via `useTabHostClient`, the picker's `runTargetHostId` / create-profile
 * capability gate, `ProviderProfileAddFlowHost` itself) shares this one
 * resolution - same entry lookup order, same `null` conditions - so they can
 * never disagree about the target host, or about whether it has resolved yet
 * in a given paint.
 *
 * Both branches now resolve the same way (redesign D17 / P2.1): the `null`
 * branch hands back the effective host's pinned requester rather than the
 * spine itself, so "following" is a resolution of the selection layer's id -
 * not a privileged client that re-aims itself underneath its holder.
 */
export function useHostClientForHostId(
  hostId: string | null,
): HostClient<HostRpcRegistry> | null {
  const followingClient = useHostClient();
  const targetEntry = useHostDirectoryEntryForHostId(hostId);
  const transientClient = useHostClientFor(targetEntry);
  return hostId === null ? followingClient : transientClient;
}

/**
 * The directory entry an explicit host id resolves to - the lookup half of
 * {@link useHostClientForHostId}, extracted so the STREAM side can reach the
 * same answer.
 *
 * Extracted rather than copied, and that is the point: the doc above commits
 * this resolution to being the ONE answer to "which host does this id resolve
 * to", with the same lookup order and the same `null` conditions, so no two
 * surfaces can disagree about the target host or about whether it has resolved
 * yet in a given paint. A second copy for the stream transport would be a
 * second decider on exactly that question - and a unary client and a stream
 * client disagreeing about which machine an id names is the same defect this
 * epic exists to close, one transport over.
 */
export function useHostDirectoryEntryForHostId(
  hostId: string | null,
): HostDirectoryEntry | null {
  // The SPINE for the lookups below: they ask "does the directory know this
  // id", which is a question about the client's directory view, not about
  // whichever host is currently effective.
  const defaultClient = useHostRuntimeClient();
  const directory = useHostDirectoryList();
  return useMemo(() => {
    if (hostId === null) return null;

    // HostRuntime's directory is authoritative and already hydrated before it
    // publishes `defaultClient`. The Query snapshot exists to make directory
    // changes reactive, but can still be undefined on this hook's first render.
    const liveEntry = defaultClient.resolveHostById(hostId);
    if (liveEntry !== null) return liveEntry;

    // A third arm used to sit here, preserving the client's ACTIVE entry when
    // the lookup above missed. It was dead by then and is deleted now (P4.2):
    // reaching it required `resolveHostById` to miss an id the slot held, and
    // the client's own `findHostById` fallback resolved exactly that case, so
    // only a harness whose directory disagreed with its own binding could get
    // there. In production the window closed earlier still - P1.2's
    // `refreshSelectedEntry` unbinds the moment a row vanishes. Measured
    // rather than argued: deleting it survived a probe twice across every
    // consumer suite (49 files / 670 tests), and with the slot gone it is
    // unreachable by construction.
    return (
      (directory.data ?? []).find((entry) => entry.hostId === hostId) ?? null
    );
  }, [defaultClient, directory.data, hostId]);
}
