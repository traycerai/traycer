import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";

/**
 * Owns a durable transport for the lifetime of one typed stream client — the
 * single place the "open transport → build typed client → compose close →
 * close-on-throw" lifetime lives, shared by the epic / chat / terminal session
 * stores. `close()` tears down BOTH the typed client and its transport (socket
 * + wake wiring); a synchronous throw in `build` closes the half-built transport
 * so it never leaks.
 */
export function openOwnedDurableStreamClient<TClient extends { close(): void }>(
  openTransport: (hostId: string) => DurableStreamTransport,
  hostId: string,
  build: (wsStreamClient: WsStreamClient<HostStreamRpcRegistry>) => TClient,
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
