import { useMemo } from "react";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  isImportable,
  SESSION_IMPORT_HARNESSES,
} from "@/components/session-import/session-import-model";
import {
  useSessionImportScan,
  type SessionImportScanHandle,
} from "@/components/session-import/use-session-import-scan";
import {
  useStreamMethodSupportFor,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

export interface WelcomeScan {
  /** State + dispatch: the wizard reducer from `session-import-model`. */
  readonly scan: SessionImportScanHandle;
  /**
   * `sessionImport.scan` on the app-wide stream: negotiated, refused, or not
   * yet known (no client, or pre-handshake).
   */
  readonly support: StreamMethodSupport;
  /** Enabled providers ∩ the harnesses the host can read, sorted. */
  readonly providers: ReadonlyArray<GuiHarnessId>;
  /** The host has not refused a scan, and there is a roster to scan. */
  readonly eligible: boolean;
  /** Rows the user could tick, across every group the scan has produced. */
  readonly importableCount: number;
}

/**
 * The welcome modal's background scan: runs from the moment the modal opens,
 * narrowed to the session-capable providers the user has ENABLED on page 1,
 * so the sessions page is filled in by the time it is reached.
 *
 * The roster joins the scan key downstream, which is what makes a toggle on
 * page 1 restart the scan `fresh` (the question changed, so the picks reset)
 * while a reconnect over the same roster keeps the user's ticks.
 *
 * `active` is never true over an empty roster: the wire refuses `[]`, and
 * "nothing to scan" is the `no-sessions` branch, not an error.
 */
export function useWelcomeScan(input: {
  readonly open: boolean;
  readonly enabledProviderIds: ReadonlyArray<ProviderId>;
}): WelcomeScan {
  const { open, enabledProviderIds } = input;
  const wsStreamClient = useWsStreamClient();
  const support =
    useStreamMethodSupportFor(wsStreamClient, "sessionImport.scan") ??
    "unknown";
  const providers = useMemo(
    () => sessionCapableHarnesses(enabledProviderIds),
    [enabledProviderIds],
  );
  const eligible = support !== "unsupported" && providers.length > 0;
  // Active on `eligible`, NOT on a negotiated "supported": a transport that
  // drops and comes back reads "unknown" in between, and if that turned the
  // scan off the hook would forget what it was scanning and restart FRESH
  // on the same host, window and roster - re-ticking rows the user had just
  // unticked. Left active, the hook sees a null client, keeps its key and
  // treats the returning client as a reconnect. A host that has actually
  // refused the method is the one case that stays off. (The same rule the
  // Settings dialog applies through `useSessionImportAvailableFor`.)
  const active = open && eligible;
  const scan = useSessionImportScan(active, providers);
  const importableCount = useMemo(
    () => countImportable(scan.state),
    [scan.state],
  );
  return { scan, support, providers, eligible, importableCount };
}

/**
 * Enabled provider ids → the GUI harnesses the host can read sessions for,
 * sorted so equal rosters spell the same scan key whatever order enablement
 * listed them in.
 */
function sessionCapableHarnesses(
  providerIds: ReadonlyArray<ProviderId>,
): ReadonlyArray<GuiHarnessId> {
  const harnesses = new Set<GuiHarnessId>();
  for (const providerId of providerIds) {
    const harness = providerIdToGuiHarnessId(providerId);
    if (SESSION_IMPORT_HARNESSES.includes(harness)) harnesses.add(harness);
  }
  return [...harnesses].toSorted();
}

function countImportable(state: SessionImportScanHandle["state"]): number {
  let count = 0;
  for (const group of state.groups) {
    for (const candidate of group.sessions) {
      if (isImportable(candidate)) count += 1;
    }
  }
  return count;
}
