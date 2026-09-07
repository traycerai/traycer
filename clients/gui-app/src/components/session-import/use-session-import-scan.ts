import { useEffect, useReducer, useRef } from "react";
import { SessionImportScanClient } from "@traycer-clients/shared/host-transport/session-import-scan-client";
import {
  useStreamHostId,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import {
  SESSION_IMPORT_INITIAL_STATE,
  sessionImportWizardReducer,
  type SessionImportWizardAction,
  type SessionImportWizardState,
} from "@/components/session-import/session-import-model";

export interface SessionImportScanHandle {
  readonly state: SessionImportWizardState;
  readonly dispatch: (action: SessionImportWizardAction) => void;
}

/** Subscribing is what makes the host read `~/.claude` and `~/.codex` at all, so the caller decides when that
 * starts. */
export function useSessionImportScan(active: boolean): SessionImportScanHandle {
  const wsStreamClient = useWsStreamClient();
  // Taken off the same binding as the client above, never from the active-host hook, so the machine named here
  // is the machine this scan is reading (see `StreamRuntimeBinding.hostId`).
  const streamHostId = useStreamHostId();
  const [state, dispatch] = useReducer(
    sessionImportWizardReducer,
    SESSION_IMPORT_INITIAL_STATE,
  );
  // What the live subscription is reading - the machine and the scan window - or `null` while there is no
  // subscription.
  const scannedKeyRef = useRef<string | null>(null);
  const scanWindow = state.scanWindow;

  useEffect(() => {
    if (!active) {
      scannedKeyRef.current = null;
      return;
    }
    if (wsStreamClient === null) return;

    const scanKey =
      streamHostId === null ? null : `${streamHostId}::${scanWindow ?? "all"}`;
    const sameScan = scanKey !== null && scanKey === scannedKeyRef.current;
    dispatch({
      kind: "scanRestarted",
      reason: sameScan ? "reconnect" : "fresh",
    });
    scannedKeyRef.current = scanKey;
    const client = new SessionImportScanClient({
      wsStreamClient,
      providers: null,
      updatedAfter:
        scanWindow === null ? null : Date.now() - scanWindow * DAY_IN_MS,
      callbacks: {
        onStarted: (providers) => {
          // The full provider roster, before any folder lands: it is what
          // keeps the pill row present and stable for the whole scan.
          dispatch({ kind: "scanStarted", providers });
        },
        onGroup: (group) => {
          dispatch({ kind: "scanGroupArrived", group });
        },
        onProviderFailed: (failure) => {
          dispatch({ kind: "scanProviderFailed", failure });
        },
        onComplete: (totals) => {
          dispatch({ kind: "scanCompleted", totals });
        },
        onConnectionStatus: (_status, reason) => {
          // A `caller` close is this effect's own teardown, not a failure.
          if (reason === null || reason.kind !== "fatalError") return;
          dispatch({ kind: "scanFailed", detail: reason.details.reason });
        },
      },
    });
    return () => {
      client.close();
    };
  }, [active, wsStreamClient, streamHostId, scanWindow]);

  return { state, dispatch };
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
