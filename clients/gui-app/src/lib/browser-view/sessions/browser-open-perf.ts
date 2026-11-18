import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import type { PendingBrowserTabRequest } from "./browser-sessions-coordinator";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";

const receipts = new Map<string, number>();

export function logBrowserOpenSpan(
  span: "click-to-placeholder" | "click-to-real",
  request: PendingBrowserTabRequest,
  start: number,
): void {
  logPerfEvent(span, {
    requestId: request.requestId,
    hostId: request.hostId,
    scope: request.scope.kind,
    epicId: request.scope.kind === "epic" ? request.scope.epicId : null,
    durationMs: performance.now() - start,
  });
}

export function recordProvisioningReceipt(session: BrowserSessionInfo): void {
  receipts.set(
    compositeKey(session.hostId, session.sessionId),
    performance.now(),
  );
}

export function forgetProvisioningReceipt(
  hostId: string,
  sessionId: string,
): void {
  receipts.delete(compositeKey(hostId, sessionId));
}

export function measureProvisioningRow(
  hostId: string,
  sessionId: string,
): void {
  const key = compositeKey(hostId, sessionId);
  const start = receipts.get(key);
  if (start === undefined) return;
  receipts.delete(key);
  logPerfEvent("receipt-to-row", {
    hostId,
    sessionId,
    durationMs: performance.now() - start,
  });
}
