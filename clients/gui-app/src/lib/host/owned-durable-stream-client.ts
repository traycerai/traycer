import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";

/**
 * Owns a durable transport for the lifetime of one typed stream client — the
 * single place the "open transport → build typed client → compose close →
 * close-on-throw" lifetime lives, shared by the chat / terminal session
 * stores. `close()` tears down the client and transport; a synchronous build
 * throw closes the half-built transport.
 */
export function openOwnedDurableStreamClient<TClient extends { close(): void }>(
  openTransport: (hostId: string) => DurableStreamTransport,
  hostId: string,
  build: (wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>) => TClient,
): { readonly client: TClient; readonly close: () => void } {
  const transport = openTransport(hostId);
  try {
    const client = build(transport.wsStreamClient);
    appLogger.debug("[stream] owned durable client opened", { hostId });
    return {
      client,
      close: () => {
        client.close();
        transport.close();
      },
    };
  } catch (cause) {
    appLogger.error(
      "[stream] owned durable client build failed",
      { hostId },
      cause,
    );
    transport.close();
    throw cause;
  }
}
