import { useEffect, useState } from "react";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import {
  looksDialable,
  resolveLocalEntry,
} from "@/components/host/local-host-entry";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import type { HostQuitUnknownReason } from "@/lib/host/host-lifecycle-copy";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

const EMPTY_PARAMS = {};

/**
 * How long the modal waits for this machine's host to answer `host.status`
 * before it says it can't tell. Well inside main's quit budget, and short
 * enough that a hung host never turns Quit into a silent wait.
 */
export const HOST_QUIT_STATUS_BOUND_MS = 3_000;

export interface HostQuitStatusFacts {
  readonly busySessionCount: number | null;
  readonly breakdown: HostBusyBreakdownV2 | null;
  /** The negotiated `host.status` minor, `null` when unknown. */
  readonly statusMinor: number | null;
}

/**
 * What the modal knows about this machine's host.
 *
 * - `checking` - no answer READ SINCE THE MODAL OPENED yet. A cached answer
 *   from an earlier read never counts: a list the person decides on has to be
 *   the one the host gives now.
 * - `no-local-host` - this machine has no host entry at all, so there is
 *   nothing to keep or stop.
 * - `unknown` - there is a host, but its list could not be read.
 * - `busy` / `idle` - the host's own `busy` verdict. The two extra counts
 *   (shells, scheduled wakes) never change it.
 */
export type HostQuitVerdict =
  | { readonly kind: "checking" }
  | { readonly kind: "no-local-host" }
  | { readonly kind: "unknown"; readonly reason: HostQuitUnknownReason }
  | ({ readonly kind: "busy" | "idle" } & HostQuitStatusFacts);

export interface LocalHostQuitStatus {
  /** The host the list and the stop are bound to. */
  readonly localHostId: string | null;
  readonly verdict: HostQuitVerdict;
  /**
   * This machine's host id as of NOW, read synchronously from the directory
   * rather than from the last render - what a click compares against
   * `localHostId` before it answers.
   */
  readonly liveLocalHostIdNow: () => string | null;
  /** Discard the current answer and read the host again. */
  readonly recheck: () => void;
}

/**
 * `host.status` for THIS machine's host (`resolveLocalEntry`), never the
 * app-wide active host, which can be a remote machine.
 *
 * Only for a component rendered under a host runtime binding:
 * `useHostClientForHostId` throws without one, so callers split on
 * `useHostBinding()` first, exactly as `LocalHostRestartFlow` does.
 */
export function useLocalHostQuitStatus(active: boolean): LocalHostQuitStatus {
  const binding = useHostBinding();
  const directoryQuery = useHostDirectoryList();
  const localEntry = resolveLocalEntry(
    binding === null ? null : binding.directory.getLocalEntry(),
    directoryQuery.data,
  );
  const localHostId = localEntry === null ? null : localEntry.hostId;
  const client = useHostClientForHostId(localHostId);
  // `useHostClientForHostId(null)` follows the app-wide host - exactly the
  // client this read must never use - so the id guard rides with the client.
  const statusClient = localHostId !== null ? client : null;
  // When the current question was asked. An answer counts only if it landed
  // at or after this instant.
  const [since, setSince] = useState(() => Date.now());
  const [timedOutSince, setTimedOutSince] = useState<number | null>(null);
  const statusQuery = useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: undefined,
    client: statusClient,
    method: "host.status",
    params: EMPTY_PARAMS,
    options: {
      enabled: active && statusClient !== null,
      // Always ask again when the modal opens; the list stays live while it
      // is up, so work that starts or ends meanwhile shows before a click.
      staleTime: 0,
      refetchOnMount: "always",
      poll: true,
    },
  });

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      setTimedOutSince(since);
    }, HOST_QUIT_STATUS_BOUND_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [active, since]);

  const verdict = decideVerdict({
    hasLocalEntry: localEntry !== null,
    hasStatusClient: statusClient !== null,
    dialable: looksDialable(localEntry),
    freshData:
      statusQuery.data !== undefined && statusQuery.dataUpdatedAt >= since
        ? statusQuery.data
        : null,
    freshError: statusQuery.isError && statusQuery.errorUpdatedAt >= since,
    timedOut: timedOutSince === since,
    statusMinor:
      localHostId === null ? null : negotiatedStatusMinor(localHostId),
  });

  return {
    localHostId,
    verdict,
    liveLocalHostIdNow: () => {
      if (binding === null) return null;
      const entry = binding.directory.getLocalEntry();
      return entry === null ? null : entry.hostId;
    },
    recheck: () => {
      setSince(Date.now());
      void statusQuery.refetch();
    },
  };
}

function negotiatedStatusMinor(hostId: string): number | null {
  const version = readNegotiatedMethodVersion(hostId, "host.status");
  return version === null || version === false ? null : version.minor;
}

interface VerdictInput {
  readonly hasLocalEntry: boolean;
  readonly hasStatusClient: boolean;
  readonly dialable: boolean;
  readonly freshData: {
    readonly busy: boolean;
    readonly busySessionCount: number | null;
    readonly busyBreakdown: HostBusyBreakdownV2 | null;
  } | null;
  readonly freshError: boolean;
  readonly timedOut: boolean;
  readonly statusMinor: number | null;
}

/**
 * Ordered: no entry is settled absence; a dialable host with no client is a
 * question we could not put (signed out, credentials refreshing), never
 * absence; a fresh answer beats a timeout that raced it; a failed or
 * overdue read is "can't tell", never idle.
 */
export function decideVerdict(input: VerdictInput): HostQuitVerdict {
  if (!input.hasLocalEntry) return { kind: "no-local-host" };
  if (!input.hasStatusClient) {
    return {
      kind: "unknown",
      reason: input.dialable ? "no-connection" : "unreachable",
    };
  }
  if (input.freshData !== null) {
    return {
      kind: input.freshData.busy ? "busy" : "idle",
      busySessionCount: input.freshData.busySessionCount,
      breakdown: input.freshData.busyBreakdown,
      statusMinor: input.statusMinor,
    };
  }
  if (input.freshError || input.timedOut) {
    return { kind: "unknown", reason: "unreachable" };
  }
  return { kind: "checking" };
}
