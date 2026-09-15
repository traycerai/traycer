import { useEffect, useMemo, useReducer, useRef } from "react";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
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
 * Runs one scan while `active` and folds its frames into the wizard reducer.
 *
 * Subscribing is what makes the host read `~/.claude` and `~/.codex` at all,
 * so the caller decides when that starts: the Settings dialog on open, the
 * welcome modal from the moment it opens so the sessions page is filled in by
 * the time it is reached. Nothing reads those folders outside one of those
 * two surfaces. Unlike the run, a dropped scan costs nothing but a re-read,
 * so there is no attach-and-resume story here.
 *
 * `providers` narrows the scan to a roster of harnesses; `null` scans every
 * harness the host has a reader for. The wire refuses an empty roster, so a
 * caller with nothing to scan passes `active: false`, never `[]`.
 */
export function useSessionImportScan(
  active: boolean,
  providers: ReadonlyArray<GuiHarnessId> | null,
): SessionImportScanHandle {
  const wsStreamClient = useWsStreamClient();
  // Taken off the same binding as the client above, never from the active-host
  // hook, so the machine named here is the machine this scan is reading (see
  // `StreamRuntimeBinding.hostId`).
  const streamHostId = useStreamHostId();
  const [state, dispatch] = useReducer(
    sessionImportWizardReducer,
    SESSION_IMPORT_INITIAL_STATE,
  );
  // The roster by VALUE, not by identity: a caller derives it per render, and
  // keying the effect on the array itself would tear the scan down and dial
  // it again on every commit over the same roster. The string is the key the
  // effect watches, and the array the client is handed is rebuilt from it so
  // the two cannot disagree.
  const providersKey = providers === null ? null : providers.join(",");
  const stableProviders = useMemo(
    () => (providersKey === null ? null : parseProvidersKey(providersKey)),
    [providersKey],
  );
  // What the live subscription is reading - the machine, the scan window AND
  // the roster - or `null` while there is no subscription. It is what tells
  // the two restarts apart, and every part is load-bearing: a replacement
  // client dialing the SAME machine over the SAME window and roster is the
  // transport coming back under a user halfway through picking rows, so
  // their groups and ticks survive it, while a different machine is a
  // different set of sessions entirely, a different window is a different
  // question, and a different roster is a different set of sessions too -
  // all start clean. An unnameable host falls to the clearing restart on
  // purpose - unable to prove it is the same machine is not evidence that it
  // is.
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
        : `${streamHostId}::${scanWindow ?? "all"}::${providersKey ?? "*"}`;
    const sameScan = scanKey !== null && scanKey === scannedKeyRef.current;
    dispatch({
      kind: "scanRestarted",
      reason: sameScan ? "reconnect" : "fresh",
    });
    scannedKeyRef.current = scanKey;
    const client = new SessionImportScanClient({
      wsStreamClient,
      providers: stableProviders,
      updatedAfter:
        scanWindow === null ? null : Date.now() - scanWindow * DAY_IN_MS,
      callbacks: {
        onImportedSupport: (support) => {
          dispatch({ kind: "scanImportedSupportChanged", support });
        },
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
  }, [
    active,
    wsStreamClient,
    streamHostId,
    scanWindow,
    providersKey,
    stableProviders,
  ]);

  return { state, dispatch };
}

/**
 * The roster back out of its key. Every segment went in as a `GuiHarnessId`,
 * so the parse is a formality - but it is a typed formality rather than a
 * cast, and a segment that somehow is not one is dropped rather than sent.
 */
function parseProvidersKey(key: string): ReadonlyArray<GuiHarnessId> {
  return key.split(",").flatMap((segment) => {
    const parsed = guiHarnessIdSchema.safeParse(segment);
    return parsed.success ? [parsed.data] : [];
  });
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
