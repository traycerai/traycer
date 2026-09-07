import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { planRestrictedReprobeAtFromClosedReason } from "@traycer-clients/shared/host-transport/remote/config";
import { appLogger } from "@/lib/logger";

const REPROBE_RETRY_DELAY_MS = 1_000;
const MAX_REPROBE_REBUILD_ATTEMPTS = 3;

/** Turn a terminal plan-denial deadline on `wsStreamClient` into an OWNER rebuild, and hand back the unsubscribe. */
export function attachPlanRestrictedReprobe(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  onPlanRestrictedReprobe: (() => void) | null,
): () => void {
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
      // A rebuild can fail after it has closed this owned client.
      // Keep the recovery trigger in this closure alive for a bounded number of backed-off attempts; the retained owner callback is disposal-aware and becomes a no-op once its store is gone.
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
      wsStreamClient.getClosedReason(),
    );
    if (reprobeAt === null || onPlanRestrictedReprobe === null) return;
    if (reprobeTimer !== null) window.clearTimeout(reprobeTimer);
    reprobeAttempts = 0;
    reprobeTimer = window.setTimeout(
      runPlanRestrictedReprobe,
      Math.max(0, reprobeAt - Date.now()),
    );
  };
  const unsubscribeClosed = wsStreamClient.onClosed(
    schedulePlanRestrictedReprobe,
  );
  // RemoteSession.onClosed deliberately does not retro-fire.
  // A negative- cache adoption can therefore hand this owner an already-closed client; inspect it after subscribing so neither close ordering loses the timer.
  if (wsStreamClient.isClosed()) {
    schedulePlanRestrictedReprobe();
  }
  return () => {
    unsubscribeClosed();
    if (reprobeTimer !== null) window.clearTimeout(reprobeTimer);
  };
}

/**
 * Owns a durable transport for the lifetime of one typed stream client - the single place the "open transport → build typed client → compose close → close-on-throw" lifetime lives, shared by the epic / chat / terminal session stores.
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
    let detachReprobe: () => void;
    try {
      detachReprobe = attachPlanRestrictedReprobe(
        transport.wsStreamClient,
        onPlanRestrictedReprobe,
      );
    } catch (cause) {
      client.close();
      throw cause;
    }
    appLogger.debug("[stream] owned durable client opened", { hostId });
    return {
      client,
      close: () => {
        detachReprobe();
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
