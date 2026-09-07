import {
  queryOptions,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { subscribeHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type {
  ClosePlainTerminalRequest,
  ImportLegacyPlainTerminalRequest,
  ImportLegacyPlainTerminalResponse,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  PlainTerminalMigrationCoordinator,
  getPlainTerminal,
  plainTerminalCollectionIdentityKey,
  plainTerminalCollectionValues,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { consumeRetainedPlainTerminalTombstone } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";
import {
  providerLoginTerminalProviderId,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";
import {
  LANDING_TERMINAL_SOURCE_STORE_VERSION,
  absentListingProvesDeath,
  isProviderLoginLandingTab,
  terminalSessionKey,
  useLandingTerminalStore,
  type LandingTerminalPendingKill,
} from "@/stores/home/landing-terminal-store";
import {
  adoptListedProviderLoginSessions,
  reconcileHostAuthoritativeLandingTerminalTabs,
  reconcileLandingTerminalTabs,
  retiredProviderLoginPredecessors,
  type LandingTerminalReconciliationInput,
} from "./landing-terminal-reconciliation";
import type { LandingTerminalAvailability } from "./landing-terminal-availability";
import type { LandingTerminalAuthorityEntry } from "./landing-terminal-authority-fleet";
import type { LandingTerminalHostContext } from "./landing-terminal-host-context";
import type { LandingTerminalKillVariables } from "./use-landing-terminal-kill-mutation";

const INDEPENDENT_SCOPE = { kind: "independent" } as const;
const migrationCoordinator = new PlainTerminalMigrationCoordinator();

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function reconciliationGenerationIsStale(
  signal: AbortSignal,
  client: HostClient<HostRpcRegistry>,
  activeHostId: string,
): boolean {
  return isAborted(signal) || client.getActiveHostId() !== activeHostId;
}

function abortError(): DOMException {
  return new DOMException("Landing terminal list fetch aborted", "AbortError");
}

function abortableRequest<Value>(
  request: () => Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (isAborted(signal)) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void request().then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // Normalized, not passed through raw: this queryFn writes the same `terminal.list` cache slot that
        // `useTerminalListFor` types as `HostRpcError`.
        reject(toHostRpcError(error, "terminal.list"));
      },
    );
  });
}

interface LandingTerminalReconciliationArgs {
  readonly landingPageId: string;
  readonly activeHostId: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly panelOpen: boolean;
  readonly primaryWorkspacePath: string | null;
  readonly generation: number;
  /** `null` is the fail-closed signal: an opening gesture that could not pin a transient client to its captured
   * host projects `null` here. */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly plainAuthority: LandingTerminalAuthorityEntry | null;
  readonly killTerminal: (
    variables: LandingTerminalKillVariables,
  ) => Promise<unknown>;
  readonly onReconciled: (context: LandingTerminalHostContext) => void;
  /** Runs when the fresh terminal list cannot be fetched for this generation. */
  readonly onError: () => void;
  /** Runs after a reconciliation generation has fully applied (store updated, host context published). */
  readonly onSettled: (
    generation: number,
    context: LandingTerminalHostContext,
  ) => void;
}

function landingTerminalListQueryOptions(client: HostClient<HostRpcRegistry>) {
  return queryOptions({
    // `HostClient.getActiveHostId` is the same host id captured by the reconciliation effect.
    queryKey: hostQueryKeys.method<HostRpcRegistry, "terminal.list">(
      client.getActiveHostId(),
      "terminal.list",
      { scope: INDEPENDENT_SCOPE },
    ),
    queryFn: ({ signal }) =>
      abortableRequest(
        () =>
          client.request("terminal.list", {
            scope: INDEPENDENT_SCOPE,
          }),
        signal,
      ),
    staleTime: 0,
  });
}

/** A cached capability probe may show the panel, but only this zero-stale list fetch may classify a session,
 * clear a tombstone, adopt an orphan, publish `homeCwd`, or auto-spawn. */
export function useLandingTerminalReconciliation(
  args: LandingTerminalReconciliationArgs,
): void {
  const {
    activeHostId,
    availability,
    landingPageId,
    panelOpen,
    primaryWorkspacePath,
    generation,
    client,
    plainAuthority,
    killTerminal,
    onReconciled,
    onError,
    onSettled,
  } = args;
  const queryClient = useQueryClient();
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const reconciliationRef = useRef<string | null>(null);
  // Sign-in provenance is read imperatively inside the pass (`providerLoginProviderFor`), so a record arriving
  // after the pass ran - a peer window's `storage` event.
  const provenanceRevision = useProviderLoginTerminalsStore(
    (state) => state.revision,
  );

  // Two wakes, because two different things can make this panel's list stale and only one of them is an event
  // about the client.
  useEffect(() => {
    if (activeHostId === null) return;
    return subscribeHostRowChanged(activeHostId, () => {
      setConnectionEpoch((current) => current + 1);
    });
  }, [activeHostId]);
  useEffect(() => {
    if (client === null) return;
    return client.onChange((event) => {
      if (event.currentHostId !== activeHostId) return;
      if (event.reason === "availability-recovered") {
        setConnectionEpoch((current) => current + 1);
      }
    });
  }, [activeHostId, client]);

  useEffect(() => {
    if (
      client === null ||
      activeHostId === null ||
      availability !== "supported" ||
      plainAuthority === null ||
      plainAuthority.authority.capability.status === "unknown"
    ) {
      return;
    }
    const reconciliationKey = [
      activeHostId,
      panelOpen ? "open" : "closed",
      primaryWorkspacePath ?? "no-workspace",
      connectionEpoch,
      generation,
      plainAuthority.authority.capability.status,
      plainAuthority.authority.collection?.projectionSequence ?? -1,
      plainAuthority.authority.canMutate ? "mutable" : "read-only",
      provenanceRevision,
    ].join("\u0000");
    if (reconciliationRef.current === reconciliationKey) return;
    reconciliationRef.current = reconciliationKey;

    const controller = new AbortController();
    const listQuery = landingTerminalListQueryOptions(client);
    const releaseLatch = (): void => {
      if (reconciliationRef.current === reconciliationKey) {
        reconciliationRef.current = null;
      }
    };

    void (async () => {
      await queryClient.cancelQueries({
        queryKey: listQuery.queryKey,
        exact: true,
      });
      if (
        reconciliationGenerationIsStale(controller.signal, client, activeHostId)
      ) {
        releaseLatch();
        return;
      }
      // Consume the complete fresh response: sessions drive reconciliation,
      // `homeCwd` is published only after host identity is rechecked below.
      const freshResponse = await queryClient.fetchQuery(listQuery).then(
        (response) => response,
        () => null,
      );
      if (
        reconciliationGenerationIsStale(controller.signal, client, activeHostId)
      ) {
        releaseLatch();
        return;
      }
      if (freshResponse === null) {
        onError();
        releaseLatch();
        return;
      }

      const freshSessions = freshResponse.sessions;
      const hostContext: LandingTerminalHostContext = {
        hostId: activeHostId,
        homeCwd: freshResponse.homeCwd,
      };

      const initial = useLandingTerminalStore.getState();

      if (plainAuthority.authority.capability.status === "capable") {
        // From `terminal.list`, which the capable pass below never reads: a host-created sign-in session has no
        // plain-terminal row, so the projection cannot adopt it, and a sign-in started in another window.
        adoptListedSignInSessions({
          activeHostId,
          landingPageId,
          sessions: freshSessions,
        });
        // A read-only authority is a reconnecting list stream, not a failed fetch.
        if (!plainAuthority.authority.canMutate) {
          releaseLatch();
          return;
        }
        const outcome: CapableLandingTerminalReconciliationOutcome | "failed" =
          await reconcileCapableLandingTerminals({
            activeHostId,
            landingPageId,
            capability: plainAuthority.authority.capability,
            canMutate: plainAuthority.authority.canMutate,
            closeTerminal: (request) =>
              plainAuthority.mutations.close.mutateAsync({
                ...request,
                hostId: activeHostId,
              }),
            importLegacyTerminal: (request) =>
              plainAuthority.mutations.importLegacy.mutateAsync(request),
            providerLoginProviderFor: (sessionId) =>
              providerLoginTerminalProviderId(activeHostId, sessionId),
            queryClient,
          }).then(
            (settled) => settled,
            (): "failed" => "failed",
          );
        // Same reasoning as the read-only guard above: a snapshot that went non-fresh mid-pass is a wait, not a fetch
        // failure, and only a real rejection may surface the directory error.
        if (outcome !== "reconciled") {
          if (outcome === "failed") onError();
          releaseLatch();
          return;
        }
        if (
          reconciliationGenerationIsStale(
            controller.signal,
            client,
            activeHostId,
          )
        ) {
          releaseLatch();
          return;
        }
        onReconciled(hostContext);
        onSettled(generation, hostContext);
        return;
      }

      const hostTombstones = initial.pendingKills.filter(
        (pending) => pending.hostId === activeHostId,
      );
      const excludedSessionKeys = new Set(
        hostTombstones.map((pending) =>
          terminalSessionKey(pending.hostId, pending.sessionId),
        ),
      );
      const listedSessionIds = new Set(
        freshSessions.map((session) => session.sessionId),
      );
      await drainLegacyLandingTombstones({
        hostTombstones,
        listedSessionIds,
        killTerminal,
      });
      if (
        reconciliationGenerationIsStale(controller.signal, client, activeHostId)
      ) {
        releaseLatch();
        return;
      }

      const current = useLandingTerminalStore.getState();
      const reconciliation = reconcileLandingTerminalTabs({
        tabs: current.tabs,
        activeInstanceId: current.activeInstanceId,
        activeHostId,
        sessions: freshSessions,
        excludedSessionKeys,
        mintInstanceId: () => `landing-terminal-${uuidv4()}`,
        providerLoginProviderFor: (sessionId) =>
          providerLoginTerminalProviderId(activeHostId, sessionId),
      });
      current.applyReconciliation(
        landingPageId,
        reconciliation.tabs,
        reconciliation.activeInstanceId,
        reconciliation.collapseWhenEmpty,
      );
      // Publish only after session reconciliation applied and host identity
      // still matches. Auto-spawn gets the same object synchronously.
      onReconciled(hostContext);
      onSettled(generation, hostContext);
    })();

    return () => {
      controller.abort();
      void queryClient.cancelQueries({
        queryKey: listQuery.queryKey,
        exact: true,
      });
      releaseLatch();
    };
  }, [
    activeHostId,
    availability,
    client,
    connectionEpoch,
    generation,
    killTerminal,
    landingPageId,
    onReconciled,
    onError,
    onSettled,
    panelOpen,
    plainAuthority,
    primaryWorkspacePath,
    provenanceRevision,
    queryClient,
  ]);
}

/** Adds a tab for every registry-claimed sign-in session the host lists that has none, keeping the current
 * selection. */
function adoptListedSignInSessions(args: {
  readonly activeHostId: string;
  readonly landingPageId: string;
  readonly sessions: LandingTerminalReconciliationInput["sessions"];
}): void {
  const { activeHostId } = args;
  const current = useLandingTerminalStore.getState();
  const adopted = adoptListedProviderLoginSessions({
    tabs: current.tabs,
    activeHostId,
    sessions: args.sessions,
    excludedSessionKeys: new Set(
      current.pendingKills
        .filter((pending) => pending.hostId === activeHostId)
        .map((pending) =>
          terminalSessionKey(pending.hostId, pending.sessionId),
        ),
    ),
    mintInstanceId: () => `landing-terminal-${uuidv4()}`,
    providerLoginProviderFor: (sessionId) =>
      providerLoginTerminalProviderId(activeHostId, sessionId),
  });
  // The predecessors the listing supersedes - a restart another window pressed killed them, and only that window
  // retired its tab. Independent of what this pass adopted: the successor may already be a tab here.
  const retired = new Set(
    retiredProviderLoginPredecessors({
      tabs: current.tabs,
      activeHostId,
      sessions: args.sessions,
      providerLoginProviderFor: (sessionId) =>
        providerLoginTerminalProviderId(activeHostId, sessionId),
    }),
  );
  if (adopted.length === 0 && retired.size === 0) return;
  current.applyReconciliation(
    args.landingPageId,
    [...current.tabs.filter((tab) => !retired.has(tab.instanceId)), ...adopted],
    current.activeInstanceId,
    // Retirement is a removal: a pass that retires the last tab must collapse
    // the panel, or the settlement's empty-panel path spawns a plain shell.
    retired.size > 0,
  );
}

/** `"snapshot-not-fresh"` is a wait, not a failure: the list stream is reconnecting or its snapshot has been
 * invalidated. */
export type CapableLandingTerminalReconciliationOutcome =
  | "reconciled"
  | "snapshot-not-fresh";

/** Exported for the same reason `reconcileCapableLandingTerminals` is - it is the half of the reconciliation
 * that has to be driven directly to be tested at all. */
export async function drainLegacyLandingTombstones(args: {
  readonly hostTombstones: ReadonlyArray<LandingTerminalPendingKill>;
  readonly listedSessionIds: ReadonlySet<string>;
  readonly killTerminal: (variables: {
    readonly hostId: string;
    readonly sessionId: string;
  }) => Promise<unknown>;
}): Promise<void> {
  for (const pending of args.hostTombstones) {
    // Absence from the host's own list is only proof of death for a session it had already acknowledged.
    if (
      !args.listedSessionIds.has(pending.sessionId) &&
      absentListingProvesDeath(pending)
    ) {
      useLandingTerminalStore
        .getState()
        .clearPendingKill(pending.hostId, pending.sessionId);
    }
  }
  await Promise.all(
    args.hostTombstones
      .filter((pending) => args.listedSessionIds.has(pending.sessionId))
      .map((pending) =>
        // `terminal.kill` is scheduled `fifo` and `selectJob` returns null for fifo rather than joining an identical
        // queued job.
        requestLandingTerminalClose({
          hostId: pending.hostId,
          sessionId: pending.sessionId,
          close: () =>
            args
              .killTerminal({
                hostId: pending.hostId,
                sessionId: pending.sessionId,
              })
              .then(() => undefined),
        }).then(
          () => undefined,
          () => undefined,
        ),
      ),
  );
}

export async function reconcileCapableLandingTerminals(args: {
  readonly activeHostId: string;
  readonly landingPageId: string;
  readonly capability: LandingTerminalAuthorityEntry["authority"]["capability"];
  readonly canMutate: boolean;
  readonly closeTerminal: (
    request: ClosePlainTerminalRequest,
  ) => Promise<unknown>;
  readonly importLegacyTerminal: (
    request: ImportLegacyPlainTerminalRequest,
  ) => Promise<ImportLegacyPlainTerminalResponse>;
  /** The provider a session was opened to sign in to, already bound to `activeHostId`. */
  readonly providerLoginProviderFor: (sessionId: string) => ProviderId | null;
  readonly queryClient: QueryClient;
}): Promise<CapableLandingTerminalReconciliationOutcome> {
  const { activeHostId, queryClient } = args;
  const queryKey = hostQueryKeys.plainTerminals(
    activeHostId,
    INDEPENDENT_SCOPE,
  );
  const initialCollection =
    queryClient.getQueryData<PlainTerminalCollection>(queryKey);
  if (initialCollection?.streamSnapshotFresh !== true) {
    return "snapshot-not-fresh";
  }
  const store = useLandingTerminalStore.getState();
  const pendingKills = store.pendingKills.filter(
    (pending) => pending.hostId === activeHostId,
  );

  await Promise.all(
    pendingKills.map(async (pending) => {
      const collection =
        queryClient.getQueryData<PlainTerminalCollection>(queryKey);
      const projected =
        getPlainTerminal(collection, pending.hostId, pending.sessionId) !==
        undefined;
      if (projected) {
        // Through the shared coordinator, never straight at the mutation.
        const outcome = await requestLandingTerminalClose({
          hostId: pending.hostId,
          sessionId: pending.sessionId,
          close: () =>
            args
              .closeTerminal({ terminalId: pending.sessionId })
              .then(() => undefined),
        });
        // Only the owner of the request may retire the record. Clearing on a joined promise would drop the record in
        // front of the PTY that create is about to produce.
        if (!outcome.owned) return;
      } else if (!absentListingProvesDeath(pending)) {
        // The close was never sent and absence proves nothing here - an in-flight create is simply not projected yet,
        // and a legacy session never appears in a plain collection at all.
        return;
      }
      useLandingTerminalStore
        .getState()
        .clearPendingKill(activeHostId, pending.sessionId);
    }),
  );

  const postKillCollection =
    queryClient.getQueryData<PlainTerminalCollection>(queryKey);
  if (postKillCollection?.streamSnapshotFresh !== true) {
    return "snapshot-not-fresh";
  }

  // A host-created sign-in session is manager-owned and import-exempt: it is not legacy evidence, and
  // `importLegacy` under its id would hand the plain registry a session it never spawned.
  const legacyTabs = useLandingTerminalStore
    .getState()
    .tabs.filter(
      (tab) =>
        tab.hostId === activeHostId &&
        tab.hostAuthorityAcknowledged !== true &&
        tab.pendingCreate !== true &&
        !isProviderLoginLandingTab(tab) &&
        args.providerLoginProviderFor(tab.sessionId) === null,
    );
  await Promise.all(
    legacyTabs.map(async (legacyTab) => {
      const collection =
        queryClient.getQueryData<PlainTerminalCollection>(queryKey);
      const known = getPlainTerminal(
        collection,
        legacyTab.hostId,
        legacyTab.sessionId,
      );
      if (known !== undefined) {
        useLandingTerminalStore
          .getState()
          .adoptHostTerminal(legacyTab.instanceId, known);
        return;
      }
      if (
        collection?.deletedRevisionByIdentity[
          plainTerminalCollectionIdentityKey(
            legacyTab.hostId,
            legacyTab.sessionId,
          )
        ] !== undefined
      ) {
        consumeRetainedPlainTerminalTombstone({
          queryClient,
          queryKey,
          hostId: activeHostId,
          terminalId: legacyTab.sessionId,
        });
        return;
      }
      await migrationCoordinator.migrate(
        {
          hostId: activeHostId,
          scope: INDEPENDENT_SCOPE,
          capability: args.capability,
          canMutate: args.canMutate,
          importLegacy: args.importLegacyTerminal,
        },
        {
          read: () => {
            const current = useLandingTerminalStore
              .getState()
              .tabs.find((tab) => tab.instanceId === legacyTab.instanceId);
            if (
              current === undefined ||
              current.hostAuthorityAcknowledged === true ||
              current.pendingCreate === true
            ) {
              return null;
            }
            return {
              terminalId: current.sessionId,
              hostId: current.hostId,
              scope: INDEPENDENT_SCOPE,
              cwd: current.cwd,
              name: current.name,
              titleSource: current.titleSource,
              sourceStoreVersion:
                current.sourceStoreVersion ??
                LANDING_TERMINAL_SOURCE_STORE_VERSION,
            };
          },
          adoptCanonical: (response) => {
            useLandingTerminalStore
              .getState()
              .adoptHostTerminal(legacyTab.instanceId, response.terminal);
          },
        },
      );
    }),
  );

  const collection =
    queryClient.getQueryData<PlainTerminalCollection>(queryKey);
  if (collection?.streamSnapshotFresh !== true) {
    return "snapshot-not-fresh";
  }
  const current = useLandingTerminalStore.getState();
  const excludedTerminalKeys = new Set(
    current.pendingKills
      .filter((pending) => pending.hostId === activeHostId)
      .map((pending) => terminalSessionKey(pending.hostId, pending.sessionId)),
  );
  const reconciliation = reconcileHostAuthoritativeLandingTerminalTabs({
    tabs: current.tabs,
    activeInstanceId: current.activeInstanceId,
    hostId: activeHostId,
    terminals: plainTerminalCollectionValues(collection),
    excludedTerminalKeys,
    mintInstanceId: () => `landing-terminal-${uuidv4()}`,
    providerLoginProviderFor: args.providerLoginProviderFor,
  });
  current.applyReconciliation(
    args.landingPageId,
    reconciliation.tabs,
    reconciliation.activeInstanceId,
    reconciliation.collapseWhenEmpty,
  );
  return "reconciled";
}
