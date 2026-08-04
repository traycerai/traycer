import { useEffect, type ReactNode } from "react";
import { ManagedCommandListStreamClient } from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { managedCommandListRegistry } from "@/stores/managed-commands/managed-command-list-registry";
import {
  createManagedCommandListStore,
  type ManagedCommandListStreamClientFactory,
} from "@/stores/managed-commands/managed-command-list-store";
import { getManagedCommandListStreamClientFactoryOverride } from "@/providers/managed-command-list-stream-factory-override";

export interface ManagedCommandListStreamMountProps {
  readonly epicId: string;
}

/**
 * Headless lifecycle owner for one epic's `managedCommand.subscribeList`
 * stream. Mounted inside the epic pane (where the app-wide `WsStreamClient` and
 * the epic id are both in scope), it acquires the registry entry for `epicId`
 * and releases it on unmount; the sidebar section, chat strips and output
 * windows read the entry by `epicId`, so this mount renders nothing itself.
 *
 * A host that does not serve the method rejects the open, so the mount stays
 * closed there and the surfaces read "unavailable" rather than empty.
 */
export function ManagedCommandListStreamMount(
  props: ManagedCommandListStreamMountProps,
): ReactNode {
  const { epicId } = props;
  const wsStreamClient = useWsStreamClient();
  const listUnsupported =
    useStreamMethodSupport("managedCommand.subscribeList") === "unsupported";

  useEffect(() => {
    if (listUnsupported) return;
    const override = getManagedCommandListStreamClientFactoryOverride();
    if (override === null && wsStreamClient === null) return;
    // Token identifies the transport this entry is bound to; a host swap
    // changes the `WsStreamClient` identity and rebuilds the store.
    const clientToken: unknown = override !== null ? override : wsStreamClient;
    const streamClientFactory: ManagedCommandListStreamClientFactory =
      override !== null
        ? override
        : (streamEpicId, callbacks) => {
            if (wsStreamClient === null) {
              throw new Error(
                "ManagedCommandListStreamMount: WsStreamClient missing at open time.",
              );
            }
            return new ManagedCommandListStreamClient({
              wsStreamClient,
              epicId: streamEpicId,
              callbacks,
            });
          };
    managedCommandListRegistry.acquire(epicId, clientToken, () =>
      createManagedCommandListStore({ epicId, streamClientFactory }),
    );
    return () => {
      managedCommandListRegistry.release(epicId);
    };
  }, [epicId, listUnsupported, wsStreamClient]);

  return null;
}
