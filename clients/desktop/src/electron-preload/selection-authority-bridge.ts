/**
 * The choreography itself is shared code (`RotatingSelectionAuthorityClient`) so the desktop and browser/dev bindings cannot drift; this module only supplies the transport.
 * PARSER BOUNDARY: every raw value crossing INTO the renderer goes through the contract's parsers here.
 */
import { ipcRenderer } from "electron";
import {
  parseActivateResult,
  parseReattachRequired,
  parseRevisionedLeaseSnapshots,
  parseRevisionedSelectionChange,
  parseSelectionAttachResult,
  type ActivateResult,
  type LiveSessionAnnouncement,
  type SelectionAttachResult,
  type SelectionAuthorityClient,
  type SelectionEvidenceReport,
  type SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  BufferedSelectionAuthorityClient,
  RotatingSelectionAuthorityClient,
  type SelectionAuthorityClientTransport,
} from "@traycer-clients/shared/host-selection/buffered-selection-authority-client";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import {
  RunnerHostSync,
  SelectionAuthorityChannels,
} from "../ipc-contracts/ipc-channels";
import { readSyncNumber } from "./sync-bootstrap";

/** No issued generation: main declined the sync read (unknown sender). */
const NO_ISSUED_ATTACH_SEQ = -1;

const preloadLog: AuthorityLog = {
  debug: (message, detail) => {
    console.debug(message, detail);
  },
  warn: (message, detail) => {
    console.warn(message, detail);
  },
};

/** Subscribes to an event channel, parsing every envelope and dropping the ones that do not parse (the next event, or a re-attach, corrects). */
function subscribeParsed<T>(
  channel: string,
  parse: (raw: unknown) => T | null,
  listener: (value: T) => void,
): SelectionSubscription {
  const wrapped = (_event: unknown, payload: unknown): void => {
    const parsed = parse(payload);
    if (parsed === null) return;
    listener(parsed);
  };
  ipcRenderer.on(channel, wrapped);
  return {
    dispose: () => {
      ipcRenderer.removeListener(channel, wrapped);
    },
  };
}

export function buildSelectionFleetRefresh(): () => Promise<void> {
  return () =>
    ipcRenderer.invoke(
      SelectionAuthorityChannels.invoke.refreshFleet,
    ) as Promise<void>;
}

function createIpcTransport(): SelectionAuthorityClientTransport {
  return {
    allocateAttachSeq: () =>
      readSyncNumber(RunnerHostSync.selectionAttachSeq, NO_ISSUED_ATTACH_SEQ),
    attach: (request) =>
      ipcRenderer
        .invoke(SelectionAuthorityChannels.invoke.attach, request)
        .then((raw: unknown) => {
          const parsed = parseSelectionAttachResult(raw);
          if (parsed === null) {
            // Unusable completion: treated exactly like a rejection, which
            // the client turns into a disposed instance.
            throw new Error("selection attach result did not parse");
          }
          return parsed;
        }),
    reportEvidence: (incarnationId, report) =>
      ipcRenderer.invoke(
        SelectionAuthorityChannels.invoke.reportEvidence,
        incarnationId,
        report,
      ) as Promise<void>,
    activate: (incarnationId, hostId) =>
      ipcRenderer
        .invoke(
          SelectionAuthorityChannels.invoke.activate,
          incarnationId,
          hostId,
        )
        .then((raw: unknown) => parseActivateResult(raw)),
    onSelectionChanged: (listener) =>
      subscribeParsed(
        SelectionAuthorityChannels.event.selectionChanged,
        parseRevisionedSelectionChange,
        listener,
      ),
    onLeasesChanged: (listener) =>
      subscribeParsed(
        SelectionAuthorityChannels.event.leasesChanged,
        parseRevisionedLeaseSnapshots,
        listener,
      ),
    onReattachRequired: (listener) =>
      subscribeParsed(
        SelectionAuthorityChannels.event.reattachRequired,
        parseReattachRequired,
        listener,
      ),
  };
}

export function buildSelectionAuthorityBridge(): SelectionAuthorityClient {
  const transport = createIpcTransport();
  const client = new RotatingSelectionAuthorityClient(
    () => new BufferedSelectionAuthorityClient(transport, preloadLog),
    preloadLog,
  );
  return {
    attach: (
      callerContractVersion: number,
      liveSessions: readonly LiveSessionAnnouncement[],
    ): Promise<SelectionAttachResult> =>
      client.attach(callerContractVersion, liveSessions),
    reportEvidence: (report: SelectionEvidenceReport): Promise<void> =>
      client.reportEvidence(report),
    activate: (hostId: string): Promise<ActivateResult> =>
      client.activate(hostId),
    onSelectionChanged: (listener) => client.onSelectionChanged(listener),
    onLeasesChanged: (listener) => client.onLeasesChanged(listener),
    onReattachRequired: (listener) => client.onReattachRequired(listener),
  };
}
