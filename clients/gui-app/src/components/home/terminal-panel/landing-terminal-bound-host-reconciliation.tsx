import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ImportLegacyPlainTerminalRequest,
  ImportLegacyPlainTerminalResponse,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import type { LandingTerminalAuthorityEntry } from "./landing-terminal-authority-fleet";
import { reconcileCapableLandingTerminals } from "./use-landing-terminal-reconciliation";

/**
 * Keeps every non-selected host represented in the landing presentation on
 * its own authority lifecycle. The selected host remains owned by the opening
 * gesture reconciliation because that pass also publishes homeCwd and settles
 * auto-create; this fleet supplies the same canonical migration/reconciliation
 * for all other bound hosts without moving layout or selection between clients.
 */
export function LandingTerminalBoundHostReconciliationFleet(props: {
  readonly landingPageId: string;
  readonly selectedHostId: string | null;
  readonly entries: LandingTerminalBoundHostAuthorityEntries;
}): ReactNode {
  return Object.entries(props.entries).flatMap(([hostId, entry]) =>
    entry === undefined || hostId === props.selectedHostId
      ? []
      : [
          <LandingTerminalBoundHostReconciliation
            key={hostId}
            hostId={hostId}
            landingPageId={props.landingPageId}
            entry={entry}
          />,
        ],
  );
}

function LandingTerminalBoundHostReconciliation(props: {
  readonly hostId: string;
  readonly landingPageId: string;
  readonly entry: LandingTerminalBoundHostAuthorityEntry;
}): ReactNode {
  const { entry, hostId, landingPageId } = props;
  const queryClient = useQueryClient();
  const tabs = useLandingTerminalStore((state) => state.tabs);
  const pendingKills = useLandingTerminalStore((state) => state.pendingKills);
  const reconciliationRef = useRef<string | null>(null);

  const hostTabsFingerprint = tabs
    .filter((tab) => tab.hostId === hostId)
    .map((tab) =>
      [
        tab.instanceId,
        tab.sessionId,
        tab.cwd,
        tab.name,
        tab.titleSource,
        tab.hostAuthorityAcknowledged === true ? "ack" : "legacy",
        tab.pendingCreate === true ? "pending" : "settled",
        tab.sourceStoreVersion ?? "no-source-version",
      ].join("\u0001"),
    )
    .join("\u0002");
  const pendingKillsFingerprint = pendingKills
    .filter((pending) => pending.hostId === hostId)
    .map((pending) => pending.sessionId)
    .join("\u0001");

  useEffect(() => {
    const authority = entry.authority;
    if (
      authority.capability.status !== "capable" ||
      !authority.canMutate ||
      authority.collection?.streamSnapshotFresh !== true
    ) {
      reconciliationRef.current = null;
      return;
    }
    const reconciliationKey = [
      hostId,
      authority.capability.schemaVersion.major,
      authority.capability.schemaVersion.minor,
      authority.collection.snapshotEpoch,
      authority.collection.projectionSequence,
      hostTabsFingerprint,
      pendingKillsFingerprint,
    ].join("\u0000");
    if (reconciliationRef.current === reconciliationKey) return;
    reconciliationRef.current = reconciliationKey;
    let disposed = false;
    const releaseLatch = (): void => {
      if (!disposed && reconciliationRef.current === reconciliationKey) {
        reconciliationRef.current = null;
      }
    };

    void reconcileCapableLandingTerminals({
      activeHostId: hostId,
      landingPageId,
      capability: authority.capability,
      canMutate: authority.canMutate,
      closeTerminal: (request) =>
        entry.mutations.close.mutateAsync({ ...request, hostId }),
      importLegacyTerminal: (request) =>
        entry.mutations.importLegacy.mutateAsync(request),
      queryClient,
    }).then(
      (outcome) => {
        // A non-fresh snapshot no longer rejects, so release the latch for it
        // too - otherwise this key would stay claimed and the pass that the
        // returning snapshot should re-run would be skipped.
        if (outcome === "reconciled") return;
        releaseLatch();
      },
      () => releaseLatch(),
    );

    return () => {
      disposed = true;
    };
  }, [
    entry,
    hostId,
    hostTabsFingerprint,
    landingPageId,
    pendingKillsFingerprint,
    queryClient,
  ]);

  return null;
}
export interface LandingTerminalBoundHostAuthorityEntry {
  readonly authority: Pick<
    LandingTerminalAuthorityEntry["authority"],
    "capability" | "canMutate" | "collection"
  >;
  readonly mutations: {
    readonly close: {
      readonly mutateAsync: (request: {
        readonly hostId: string;
        readonly terminalId: string;
      }) => Promise<unknown>;
    };
    readonly importLegacy: {
      readonly mutateAsync: (
        request: ImportLegacyPlainTerminalRequest,
      ) => Promise<ImportLegacyPlainTerminalResponse>;
    };
  };
}

type LandingTerminalBoundHostAuthorityEntries = Readonly<
  Partial<Record<string, LandingTerminalBoundHostAuthorityEntry>>
>;
