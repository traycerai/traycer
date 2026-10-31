import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";

/**
 * Resolves the `HostClient` for an explicit host id captured elsewhere (a
 * tab's bound host threaded through as a plain id, a fork dialog's fixed
 * host). `null` follows the app-wide effective host; every explicit id
 * receives an identity requester, including when it currently matches that
 * host. This prevents a fixed-host caller from silently moving when the
 * effective host changes before its next render. Every surface that
 * must agree on "which host does this id resolve to" (a tab's own consumers
 * via `useTabHostClient`, the picker's `runTargetHostId` / create-profile
 * capability gate, `ProviderProfileAddFlowHost` itself) shares this one
 * resolution. The requester re-reads the row by id on every access: a booting
 * local row therefore keeps its identity while endpoint-aware readiness parks
 * execution until the row becomes dialable.
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
  const binding = useHostBinding();
  const namedClient = useMemo(
    () => (hostId === null ? null : resolveNamedHostClient(binding, hostId)),
    [binding, hostId],
  );
  return hostId === null ? followingClient : namedClient;
}

/**
 * The live directory entry for an explicit host id, used by presentation and
 * stream consumers that need row fields in addition to unary identity.
 *
 * Extracted rather than copied, and that is the point: the doc above commits
 * this lookup to being the ONE answer to "what row currently describes this
 * id". A second copy for the stream transport would be a
 * second decider on exactly that question - and a unary client and a stream
 * client disagreeing about which machine an id names is the same defect this
 * epic exists to close, one transport over.
 */
export function useHostDirectoryEntryForHostId(
  hostId: string | null,
): HostDirectoryEntry | null {
  return useHostDirectoryEntry(hostId);
}
