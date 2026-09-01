import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { planRestrictedReprobeAtFromClosedReason } from "@traycer-clients/shared/host-transport/remote/config";
import { appLogger } from "@/lib/logger";

const REPROBE_RETRY_DELAY_MS = 1_000;
const MAX_REPROBE_REBUILD_ATTEMPTS = 3;

/**
 * Owns a durable transport for the lifetime of one typed stream client — the
 * single place the "open transport → build typed client → compose close →
 * close-on-throw" lifetime lives, shared by the epic / chat / terminal session
 * stores. It also translates a terminal plan-denial deadline into an OWNER
 * rebuild: reconnecting the closed client itself cannot acquire the cache's
 * controlled fresh session. `close()` tears down the client, timer and
 * transport; a synchronous build/wiring throw closes every completed layer.
 */
export function openOwnedDurableStreamClient<TClient extends { close(): void }>(
  openTransport: (hostId: string) => DurableStreamTransport,
  hostId: string,
  build: (wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>) => TClient,
  onPlanRestrictedReprobe: (() => void) | null,
): { readonly client: TClient; readonly close: () => void } {
  const transport = openTransport(hostId);
  try {
    const client = build(transport.wsStreamClient);
    let reprobeTimer: number | null = null;
    let reprobeAttempts = 0;
    const runPlanRestrictedReprobe = (): void => {
      reprobeTimer = null;
      reprobeAttempts += 1;
      try {
        onPlanRestrictedReprobe?.();
      } catch (cause) {
        appLogger.error(
          "[stream] durable plan-restricted reprobe failed",
          {},
          cause,
        );
        // A rebuild can fail after it has closed this owned client. Keep the
        // recovery trigger in this closure alive for a bounded number of
        // backed-off attempts; the retained owner callback is disposal-aware
        // and becomes a no-op once its store is gone.
        if (reprobeAttempts < MAX_REPROBE_REBUILD_ATTEMPTS) {
          reprobeTimer = window.setTimeout(
            runPlanRestrictedReprobe,
            REPROBE_RETRY_DELAY_MS * reprobeAttempts,
          );
        }
      }
    };
    const schedulePlanRestrictedReprobe = (): void => {
      const reprobeAt = planRestrictedReprobeAtFromClosedReason(
        transport.wsStreamClient.getClosedReason(),
      );
      if (reprobeAt === null || onPlanRestrictedReprobe === null) return;
      if (reprobeTimer !== null) window.clearTimeout(reprobeTimer);
      reprobeAttempts = 0;
      reprobeTimer = window.setTimeout(
        runPlanRestrictedReprobe,
        Math.max(0, reprobeAt - Date.now()),
      );
    };
    let unsubscribeClosed: () => void;
    try {
      unsubscribeClosed = transport.wsStreamClient.onClosed(
        schedulePlanRestrictedReprobe,
      );
      // RemoteSession.onClosed deliberately does not retro-fire. A negative-
      // cache adoption can therefore hand this owner an already-closed client;
      // inspect it after subscribing so neither close ordering loses the timer.
      if (transport.wsStreamClient.isClosed()) {
        schedulePlanRestrictedReprobe();
      }
    } catch (cause) {
      client.close();
      throw cause;
    }
    appLogger.debug("[stream] owned durable client opened", { hostId });
    return {
      client,
      close: () => {
        unsubscribeClosed();
        if (reprobeTimer !== null) window.clearTimeout(reprobeTimer);
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
