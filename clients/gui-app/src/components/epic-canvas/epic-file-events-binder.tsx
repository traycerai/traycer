import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { authenticatedHostStreamKey } from "@/hooks/host/use-host-stream-client-for";
import {
  acquireEpicFileEvents,
  releaseEpicFileEvents,
} from "@/lib/epic-files/file-events-subscription";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";

/**
 * Keeps this epic's `epic.fileEvents` subscription open for as long as the pane
 * is mounted.
 *
 * Mounted inside `<EpicSessionProvider>` and NOT inside the Files panel: the
 * refusal toast has to fire whether or not that panel is open (a user who drops
 * `.env` into `files/` gets silence otherwise), and ticket 21's recording badge
 * lives on a tile, not in the sidebar. The pane is the surface whose lifetime
 * actually matches "the epic is open on this host" - it is what
 * `EpicSessionProvider` itself is scoped to, and a retained-but-hidden pane
 * keeps receiving, which is right for a notice about something happening on
 * disk right now.
 *
 * Two panes on one epic are two claims on ONE subscription; the registry
 * refcounts them.
 */
export function EpicFileEventsBinder(props: { readonly epicId: string }): null {
  const { epicId } = props;
  const hostId = useCanvasHostId();
  const hostClient = useEpicSessionHostClient();
  const hostEntry = useHostDirectoryEntry(hostId);
  // The same readiness gate the browser-sessions coordinator uses: the durable
  // transport factory THROWS for a host with no dialable directory row or no
  // signed-in user, and this key going non-null is what re-runs the effect once
  // both are true.
  const streamKey =
    hostClient === null
      ? null
      : authenticatedHostStreamKey(hostClient, hostEntry);
  const openTransport = useDurableStreamTransportFactory();
  const openTransportRef = useRef(openTransport);
  // Declared before the acquiring effect so the ref is current by the time that
  // one runs in the same commit.
  useEffect(() => {
    openTransportRef.current = openTransport;
  }, [openTransport]);
  // This pane's claim identity: stable for its lifetime, distinct from every
  // other pane's.
  const [claim] = useState<object>(() => ({}));
  const claimOpener = useCallback(
    (targetHostId: string): DurableStreamTransport =>
      openTransportRef.current(targetHostId),
    [],
  );
  useEffect(() => {
    if (hostId === null || streamKey === null) return;
    acquireEpicFileEvents({
      epicId,
      hostId,
      claim,
      openTransport: claimOpener,
    });
    return () => {
      releaseEpicFileEvents({ epicId, hostId, claim });
    };
  }, [claim, claimOpener, epicId, hostId, streamKey]);
  return null;
}
