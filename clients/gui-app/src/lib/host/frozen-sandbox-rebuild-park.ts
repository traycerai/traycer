import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { RemoteStreamClient } from "@traycer-clients/shared/host-transport/remote/index";
import {
  sandboxFreezeOf,
  TERMINAL_VERDICT_TTL_MS,
} from "@/lib/host/host-messenger";

/** The fatal a frozen sandbox's attach grant ends a session with. */
const SANDBOX_FROZEN_FATAL = "SANDBOX_FROZEN";

type Park = "none" | "unconfirmed" | "confirmed";

export interface FrozenSandboxRebuildPark {
  /**
   * Called by a stream owner whose client just closed, with
   * {@link terminalFatalCodeOf} that client: `true` parks the rebuild (the close was a frozen
   * sandbox's refusal, which a fresh session would only repeat), `false`
   * leaves the owner to rebuild as for any other close.
   */
  readonly parkIfFrozen: (terminalFatalCode: string | null) => boolean;
  /**
   * Counts the parks that ended. The owner's build effect depends on it, so
   * an end rebuilds once, as its own rebuild nonce does.
   */
  readonly releases: number;
}

type SandboxFreeze = "frozen" | "thawed" | "gone";

/**
 * A stream client's terminal fatal code. Only a remote session carries one: a
 * frozen sandbox is always reached over the relay, and a local client's close
 * is never a refusal.
 */
export function terminalFatalCodeOf<
  Registry extends VersionedStreamRpcRegistry,
>(client: IHostStreamClient<Registry>): string | null {
  return client instanceof RemoteStreamClient
    ? client.getTerminalFatalCode()
    : null;
}

const noSubscription = (): (() => void) => () => undefined;

/**
 * `sandboxFreezeOf` for `hostId`'s row, read through the connection registry
 * rather than `useHostDirectoryEntry`, for an owner that renders with no
 * runtime binding (`HostStreamProvider`).
 */
export function useRegistrySandboxFreeze(hostId: string | null): SandboxFreeze {
  const subscribe = useCallback(
    (listener: () => void) =>
      hostId === null
        ? noSubscription()
        : subscribeHostRowChanged(hostId, listener),
    [hostId],
  );
  const readFreeze = useCallback(
    () =>
      sandboxFreezeOf(hostId === null ? null : readHostDirectoryEntry(hostId)),
    [hostId],
  );
  return useSyncExternalStore(subscribe, readFreeze, readFreeze);
}

/**
 * Holds a stream owner's rebuild after its session closed `SANDBOX_FROZEN`
 * until the host list shows that sandbox thawed or gone, then counts one
 * release. The unary verdict cache in `host-messenger.ts` ends on the same
 * signal; a stream owner never consults that cache, so without this its
 * rebuild minted a grant authn refuses, once per backoff, for as long as a
 * frozen sandbox's tile or feed stayed mounted.
 *
 * `freeze` is `sandboxFreezeOf` of the owner's host row. The list is usually
 * stale when the fatal lands (the meter froze the row after the last poll),
 * so "not frozen" means thawed or gone only once the list has been seen
 * frozen since the park, as the verdict cache's `frozenConfirmed`. A park the
 * list never confirms ends after the verdict cache's own TTL for an
 * unconfirmed verdict, as that verdict does.
 */
export function useFrozenSandboxRebuildPark(
  freeze: SandboxFreeze,
): FrozenSandboxRebuildPark {
  const [park, setPark] = useState<Park>("none");
  const [releases, setReleases] = useState(0);

  // Moved while rendering, from the row this render reads.
  if (park === "unconfirmed" && freeze === "frozen") {
    setPark("confirmed");
  } else if (park === "confirmed" && freeze !== "frozen") {
    setPark("none");
    setReleases((count) => count + 1);
  }

  useEffect(() => {
    if (park !== "unconfirmed") return;
    const timer = window.setTimeout(() => {
      setPark("none");
      setReleases((count) => count + 1);
    }, TERMINAL_VERDICT_TTL_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [park]);

  const parkIfFrozen = useCallback(
    (terminalFatalCode: string | null): boolean => {
      if (terminalFatalCode !== SANDBOX_FROZEN_FATAL) return false;
      // Confirmed above once the list is seen frozen.
      setPark("unconfirmed");
      return true;
    },
    [],
  );

  return { parkIfFrozen, releases };
}
