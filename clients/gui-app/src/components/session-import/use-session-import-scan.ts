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

/**
 * Runs one scan for the lifetime of an open wizard and folds its frames into
 * the wizard reducer.
 *
 * Subscribing is what makes the host read `~/.claude` and `~/.codex` at all
 * (D13: no background scanning), so this is deliberately mounted by the wizard
 * and torn down with it. Unlike the run, a dropped scan costs nothing but a
 * re-read, so there is no attach-and-resume story here.
 */
export function useSessionImportScan(active: boolean): SessionImportScanHandle {
  const wsStreamClient = useWsStreamClient();
  // Taken off the same binding as the client above, never from the active-host
  // hook, so the machine named here is the machine this scan is reading (see
  // `StreamRuntimeBinding.hostId`).
  const streamHostId = useStreamHostId();
  const [state, dispatch] = useReducer(
    sessionImportWizardReducer,
    SESSION_IMPORT_INITIAL_STATE,
  );
  const clientRef = useRef<SessionImportScanClient | null>(null);
  // What the live subscription is reading - the machine AND the scan window -
  // or `null` while there is no subscription. It is what tells the two
  // restarts apart, and both halves are load-bearing: a replacement client
  // dialing the SAME machine over the SAME window is the transport coming
  // back under a user halfway through picking rows, so their groups and ticks
  // survive it, while a different machine is a different set of sessions
  // entirely and a different window is a different question - both start
  // clean. An unnameable host falls to the clearing restart on purpose -
  // unable to prove it is the same machine is not evidence that it is.
  const scannedKeyRef = useRef<string | null>(null);
  const scanWindow = state.scanWindow;

  useEffect(() => {
    if (!active) {
      scannedKeyRef.current = null;
      return;
    }
    if (wsStreamClient === null) return;

    const scanKey =
      streamHostId === null
        ? null
        : `${streamHostId}::${scanWindow ?? "all"}`;
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
    clientRef.current = client;

    return () => {
      clientRef.current = null;
      client.close();
    };
  }, [active, wsStreamClient, streamHostId, scanWindow]);

  return { state, dispatch };
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
