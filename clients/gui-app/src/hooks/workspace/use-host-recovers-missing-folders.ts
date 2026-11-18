import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useHostNegotiatedMethodVersion,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/** True only for a host known to have negotiated `1.<minor>` or later. */
export function hostNegotiatedAtLeast(
  version: NegotiatedMethodVersion,
  minor: number,
): boolean {
  return (
    version !== null &&
    version !== false &&
    version.major === 1 &&
    version.minor >= minor
  );
}

/**
 * Whether the host `client` addresses is KNOWN to recover a run whose bound
 * worktree or folder is gone.
 *
 * False for every state short of that knowledge - an older host, a setting
 * still loading, a failed read, the setting off - because the caller lifts a
 * block on it: a host that does not recover would refuse the send anyway, and
 * the block is what tells the person why before they send.
 *
 * `enabled` keeps the read off chats with nothing missing.
 */
export function useHostRecoversMissingFolders(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): boolean {
  const version = useHostNegotiatedMethodVersion(
    client,
    "config.worktrees.get",
  );
  const supported = hostNegotiatedAtLeast(version, 1);
  const query = useHostQuery<HostRpcRegistry, "config.worktrees.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.worktrees.get",
    params: {},
    options: { enabled: enabled && supported },
  });
  return supported && query.data?.recoverMissing === true;
}
