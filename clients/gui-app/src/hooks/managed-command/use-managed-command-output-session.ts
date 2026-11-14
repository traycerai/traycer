import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ManagedCommandOutputStreamClient,
  type ManagedCommandOutputTarget,
} from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { useHostDirectory } from "@/lib/host";
import { getManagedCommandOutputStreamClientFactoryOverride } from "@/providers/managed-command-output-stream-factory-override";
import {
  createManagedCommandOutputStore,
  type ManagedCommandOutputStoreHandle,
  type ManagedCommandOutputStreamClientFactory,
} from "@/stores/managed-commands/managed-command-output-store";

export interface ManagedCommandOutputSession {
  /** `null` until the subscribing effect has created the stream. */
  readonly session: ManagedCommandOutputStoreHandle | null;
  /**
   * Tears the stream down and opens it again from a fresh tail - the same
   * path a closed-and-reopened tab takes. The way back from a stream the host
   * closed for good; a mere drop reconnects on its own and needs no help.
   */
  readonly reopen: () => void;
}

/**
 * Opens one command's output stream for as long as its window is mounted.
 *
 * Unlike a terminal session there is nothing to keep warm: the window is a
 * viewer over a log the host owns, so closing the tab closes the stream and
 * reopening it re-reads the tail. The transport is owned by the stream client
 * (see `openOwnedDurableStreamClient`) and bound to the tab's host for life.
 */
export function useManagedCommandOutputSession(args: {
  readonly target: ManagedCommandOutputTarget;
  readonly commandId: string;
  readonly hostId: string;
}): ManagedCommandOutputSession {
  const { commandId, target, hostId } = args;
  const targetId = target.kind === "epic" ? target.epicId : target.botId;
  const targetKind = target.kind;
  const sessionChatId = target.kind === "bot" ? target.sessionChatId : "";
  const streamTarget = useMemo<ManagedCommandOutputTarget>(
    () =>
      targetKind === "epic"
        ? { kind: "epic", epicId: targetId }
        : { kind: "bot", botId: targetId, sessionChatId },
    [targetKind, targetId, sessionChatId],
  );
  const openTransport = useDurableStreamTransportFactory();
  const directory = useHostDirectory();
  // Read live rather than as an effect dependency: reopening the stream costs
  // the viewer their scroll position and re-reads the tail, so only the command
  // or host actually changing - or an explicit reopen - may do it.
  const openTransportRef = useRef(openTransport);
  const [handle, setHandle] = useState<ManagedCommandOutputStoreHandle | null>(
    null,
  );
  // Counts explicit reopens. Part of the effect's key, so bumping it runs the
  // teardown-and-recreate the effect already owns rather than a second path.
  const [generation, setGeneration] = useState(0);
  const reopen = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  // Declared before the subscribing effect so the ref is current by the time
  // that one runs in the same commit.
  useEffect(() => {
    openTransportRef.current = openTransport;
  }, [openTransport]);

  useEffect(() => {
    const override = getManagedCommandOutputStreamClientFactoryOverride();
    const streamClientFactory: ManagedCommandOutputStreamClientFactory =
      override ??
      ((_scopeId, streamCommandId, callbacks) => {
        const owned = openOwnedDurableStreamClient(
          openTransportRef.current,
          hostId,
          (ws) => {
            const stream = new ManagedCommandOutputStreamClient({
              wsStreamClient: ws,
              target: streamTarget,
              commandId: streamCommandId,
              callbacks,
            });
            // The client the subscription rides on is the one whose negotiated
            // capabilities describe THIS window's host; it travels with the
            // stream so the window never has to ask the default host instead.
            return {
              stream,
              streamMethodSupport: ws,
              close: () => stream.close(),
            };
          },
        );
        return {
          loadOlder: (frame) => owned.client.stream.loadOlder(frame),
          resnapshot: () => owned.client.stream.resnapshot(),
          close: owned.close,
          streamMethodSupport: owned.client.streamMethodSupport,
        };
      });
    let next: ManagedCommandOutputStoreHandle | null = null;
    let subscription: { dispose(): void } | null = null;
    const acquire = () => {
      if (next !== null) return;
      if (streamTarget.kind === "bot" && directory.findById(hostId) === null)
        return;
      next = createManagedCommandOutputStore({
        target: streamTarget,
        commandId,
        streamClientFactory,
      });
      subscription?.dispose();
      subscription = null;
      setHandle(next);
    };
    if (streamTarget.kind === "bot") {
      subscription = directory.onChange(acquire);
    }
    acquire();
    return () => {
      subscription?.dispose();
      setHandle(null);
      next?.dispose();
    };
  }, [commandId, streamTarget, hostId, generation, directory]);

  return { session: handle, reopen };
}
