import { useEffect, useRef, useState } from "react";
import { ManagedCommandOutputStreamClient } from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { getManagedCommandOutputStreamClientFactoryOverride } from "@/providers/managed-command-output-stream-factory-override";
import {
  createManagedCommandOutputStore,
  type ManagedCommandOutputStoreHandle,
  type ManagedCommandOutputStreamClientFactory,
} from "@/stores/managed-commands/managed-command-output-store";

/**
 * Opens one command's output stream for as long as its window is mounted.
 *
 * Unlike a terminal session there is nothing to keep warm: the window is a
 * viewer over a log the host owns, so closing the tab closes the stream and
 * reopening it re-reads the tail. The transport is owned by the stream client
 * (see `openOwnedDurableStreamClient`) and bound to the tab's host for life.
 */
export function useManagedCommandOutputSession(args: {
  readonly epicId: string;
  readonly commandId: string;
  readonly hostId: string;
}): ManagedCommandOutputStoreHandle | null {
  const { commandId, epicId, hostId } = args;
  const openTransport = useDurableStreamTransportFactory();
  // Read live rather than as an effect dependency: reopening the stream costs
  // the viewer their scroll position and re-reads the tail, so only the command
  // or host actually changing may do it.
  const openTransportRef = useRef(openTransport);
  const [handle, setHandle] = useState<ManagedCommandOutputStoreHandle | null>(
    null,
  );

  // Declared before the subscribing effect so the ref is current by the time
  // that one runs in the same commit.
  useEffect(() => {
    openTransportRef.current = openTransport;
  }, [openTransport]);

  useEffect(() => {
    const override = getManagedCommandOutputStreamClientFactoryOverride();
    const streamClientFactory: ManagedCommandOutputStreamClientFactory =
      override ??
      ((streamEpicId, streamCommandId, callbacks) => {
        const owned = openOwnedDurableStreamClient(
          openTransportRef.current,
          hostId,
          (ws) =>
            new ManagedCommandOutputStreamClient({
              wsStreamClient: ws,
              epicId: streamEpicId,
              commandId: streamCommandId,
              callbacks,
            }),
        );
        return {
          loadOlder: (frame) => owned.client.loadOlder(frame),
          close: owned.close,
        };
      });
    const next = createManagedCommandOutputStore({
      epicId,
      commandId,
      streamClientFactory,
    });
    setHandle(next);
    return () => {
      setHandle(null);
      next.dispose();
    };
  }, [commandId, epicId, hostId]);

  return handle;
}
