import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  openEpicHostIds,
  registry,
} from "@/lib/registries/epic-session-registry";
import {
  openAgentActivityStream,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

/**
 * Agent activity from the hosts the user's open epics actually live on
 * (`s5-parity-gaps` gap 1).
 *
 * ## What was wrong
 *
 * Production opened exactly ONE activity stream, pinned to the local host, so
 * an agent running on a REMOTE host against a cloud-homed epic rendered as
 * nothing happening. The prior panel approved a single-client cut for
 * PRESENCE; this was wider than that, and it is a truthfulness defect rather
 * than a cleared one - the UI states "idle" where it has no idea.
 *
 * ## Why per-open-epic and not per-directory-entry
 *
 * A stream for every host in the directory would open a relay connection per
 * machine the account has ever registered, most of which the user is not
 * looking at. The hosts whose activity is observable are the hosts their open
 * epic sessions are bound to - a set that is small, already dialed for the
 * epic itself, and shrinks the moment the tab closes.
 *
 * The LOCAL host is deliberately NOT handled here.
 * `NotificationsSessionProvider` owns that stream, on the G8 local-host pin,
 * and this component skips it so the two cannot both write the same slice.
 */
export function EpicHostActivityStreams(props: {
  readonly localHostId: string | null;
  readonly onAuthError: () => void;
}): ReactNode {
  const hostIds = useOpenEpicHostIds();
  const localHostId = props.localHostId;
  const remoteHostIds = useMemo(
    () => hostIds.filter((hostId) => hostId !== localHostId),
    [hostIds, localHostId],
  );
  return (
    <>
      {remoteHostIds.map((hostId) => (
        <EpicHostActivityStream
          key={hostId}
          hostId={hostId}
          onAuthError={props.onAuthError}
        />
      ))}
    </>
  );
}

/**
 * One host's stream. A component rather than a loop inside the parent because
 * the host client is resolved by a hook, and hooks cannot be called per item.
 */
function EpicHostActivityStream(props: {
  readonly hostId: string;
  readonly onAuthError: () => void;
}): ReactNode {
  const entry = useHostDirectoryEntry(props.hostId);
  const streamAuth = useStreamAuthRevalidator();
  const streamClient = useHostStreamClientFor(entry, streamAuth);
  const hostId = props.hostId;
  const onAuthError = props.onAuthError;
  useEffect(() => {
    if (streamClient === null) return;
    // This host's ONE reconnect policy, leased for the stream's lifetime so
    // the engine (and its backoff state) is shared with any other stream owner
    // addressing the same host.
    const connection = acquireHostConnection(hostId);
    const dispose = openAgentActivityStream(
      hostId,
      connection.reconnect,
      streamClient,
      onAuthError,
    );
    return () => {
      dispose();
      connection.release();
      // The disposer nulls its `currentClient` BEFORE closing, so the close
      // callback that would normally wipe this slice is ignored. Nothing else
      // in production calls `resetHost`, so without this the host's agent ids
      // stayed in the cross-host union after its last tab closed and read as
      // work still in progress.
      useAgentActivityStore.getState().resetHost(hostId);
    };
  }, [hostId, onAuthError, streamClient]);
  return null;
}

/**
 * The open-epic host set, as a `useSyncExternalStore` snapshot.
 *
 * `openEpicHostIds()` allocates a fresh array each call, so a naive snapshot
 * would tear down and reopen every stream on any registry event. The identity
 * guard keys on the joined ids, which is what actually decides the streams.
 */
function useOpenEpicHostIds(): readonly string[] {
  // A REF, not a `useMemo` object. `useSyncExternalStore` requires
  // `getSnapshot` to be cached-and-stable, so this memo cell is written on
  // every call - and writing to a value that was itself passed to a hook is
  // what `react-hooks/immutability` forbids. A ref is the sanctioned mutable
  // cell for exactly this, and `useCallback` no longer has to depend on it
  // (a ref object is stable for the component's life).
  const cacheRef = useRef<{ key: string; value: readonly string[] }>({
    key: "",
    value: [],
  });
  const subscribe = useCallback(
    (callback: () => void) => registry.subscribe(callback),
    [],
  );
  const getSnapshot = useCallback(() => {
    const next = openEpicHostIds();
    const key = next.join(" ");
    const cache = cacheRef.current;
    if (key === cache.key) return cache.value;
    cacheRef.current = { key, value: next };
    return next;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
