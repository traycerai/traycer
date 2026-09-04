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
        // Normalized, not passed through raw: this queryFn writes the same
        // `terminal.list` cache slot that `useTerminalListFor` types as
        // `HostRpcError`. The abort path above stays a DOMException so
        // TanStack's cancellation handling is untouched.
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
  /**
   * The host client this generation must query. `null` is the fail-closed
   * signal: an opening gesture that could not pin a transient client to its
   * captured host projects `null` here, and the effect no-ops rather than
   * falling back to the live default client (which follows runtime host
   * selection and would reconcile the wrong host).
   */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly plainAuthority: LandingTerminalAuthorityEntry | null;
  readonly killTerminal: (
    variables: LandingTerminalKillVariables,
  ) => Promise<unknown>;
  readonly onReconciled: (context: LandingTerminalHostContext) => void;
  /** Runs when the fresh terminal list cannot be fetched for this generation. */
  readonly onError: () => void;
  /**
   * Runs after a reconciliation generation has fully applied (store updated,
   * host context published). Receives the same generation's host context so
   * auto-spawn does not depend on a React state round-trip or read an earlier
   * host's home path. The panel owns auto-spawn and open-gesture retargeting.
   */
  readonly onSettled: (
    generation: number,
    context: LandingTerminalHostContext,
  ) => void;
}

function landingTerminalListQueryOptions(client: HostClient<HostRpcRegistry>) {
  return queryOptions({
    // `HostClient.getActiveHostId()` is the same host id captured by the
    // reconciliation effect. It makes the cache entry explicitly host-scoped:
    // ["host", hostId, "terminal.list", { scope: "independent" }].
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

/**
 * Runs the landing terminal lifecycle as one abortable generation. A cached
 * capability probe may show the panel, but only this zero-stale list fetch may
 * classify a session, clear a tombstone, adopt an orphan, publish `homeCwd`,
 * or auto-spawn.
 */
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
  // The THIRD wake. Sign-in provenance is read imperatively inside the pass
  // (`providerLoginProviderFor`), so a record arriving after the pass ran - a
  // peer window's `storage` event - would otherwise never re-run the matched-
  // tab classification, and the tab it should have marked stays importable
  // and recreatable until some unrelated host event happens along.
  const provenanceRevision = useProviderLoginTerminalsStore(
    (state) => state.revision,
  );

  // TWO WAKES, because two different things can make this panel's list stale
  // and only one of them is an event about the client.
  //
  // The row signal is the host's: its directory entry moving (a restart that
  // re-published an endpoint, a re-enrollment) means the terminals the panel
  // listed were listed against a route that no longer exists. That used to
  // arrive as `bind()`'s `host-updated`, which required this host to be the
  // BOUND one - the registry reports it per host, so P4.2 deleted the slot arm
  // without deleting the wake. `host-bound` needed no replacement at all: this
  // hook is keyed on `activeHostId`, so a host becoming effective already
  // re-runs the reconciliation below through the key.
  //
  // Availability recovery stays on the client, because it is not a row change:
  // nothing about the host moved, a stalled endpoint started answering again.
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
        // From `terminal.list`, which the capable pass below never reads: a
        // host-created sign-in session has no plain-terminal row, so the
        // projection cannot adopt it, and a sign-in started in another window
        // - whose record reached this one through the shared registry - would
        // otherwise have no tab here. FIRST, ahead of the plain authority's
        // own gates: the list that just answered is all this needs, and a
        // sign-in is short-lived - one that exits while the stream is
        // read-only or non-fresh could never be adopted afterwards (running
        // sessions only), and its restart surface with it. Only for the
        // selected host: the bound host fleet reconciles other hosts from
        // their projections alone and fetches no list for them.
        adoptListedSignInSessions({
          activeHostId,
          landingPageId,
          sessions: freshSessions,
        });
        // A read-only authority is a reconnecting list stream, not a failed
        // fetch. `onError` clears the picker's selected target and reports
        // "The terminal directory could not be opened.", which is simply
        // untrue here - and destroys a directory choice the user must then
        // make again. The reconciliation latch keys on `canMutate`, so this
        // pass re-runs by itself the moment mutability returns.
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
        // Same reasoning as the read-only guard above: a snapshot that went
        // non-fresh mid-pass is a wait, not a fetch failure, and only a real
        // rejection may surface the directory error.
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

/**
 * Adds a tab for every registry-claimed sign-in session the host lists that
 * has none, keeping the current selection. See
 * `adoptListedProviderLoginSessions` for why the capable arm needs this.
 */
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
  // The predecessors the listing supersedes - a restart another window
  // pressed killed them, and only that window retired its tab. Independent of
  // what this pass adopted: the successor may already be a tab here.
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
    false,
  );
}

/**
 * `"snapshot-not-fresh"` is a wait, not a failure: the list stream is
 * reconnecting or its snapshot has been invalidated, so this pass has nothing
 * authoritative to classify against and the next fresh projection re-runs it.
 * Genuine failures (a rejected close or import) still reject.
 */
export type CapableLandingTerminalReconciliationOutcome =
  | "reconciled"
  | "snapshot-not-fresh";

/**
 * The LEGACY arm of the tombstone drain: retire what the host's own list proves
 * dead, and kill what it still lists.
 *
 * Exported for the same reason `reconcileCapableLandingTerminals` is - it is the
 * half of the reconciliation that has to be driven directly to be tested at all,
 * and both of its rules are ones a silent regression would leak a PTY over.
 */
export async function drainLegacyLandingTombstones(args: {
  readonly hostTombstones: ReadonlyArray<LandingTerminalPendingKill>;
  readonly listedSessionIds: ReadonlySet<string>;
  readonly killTerminal: (variables: {
    readonly hostId: string;
    readonly sessionId: string;
  }) => Promise<unknown>;
}): Promise<void> {
  for (const pending of args.hostTombstones) {
    // Absence from the host's own list is only proof of death for a session it
    // had already acknowledged. A `terminal.plain.create` that has not settled
    // is not listed YET, and its terminal lands under this exact session id, so
    // clearing here drops the record in front of the terminal it was written to
    // kill. Left outstanding, the recovery bridge drains it on the next dialable
    // edge.
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
        // Through the shared coordinator, for the same reason the capable arm
        // and the panel's own legacy fast path use it: the recovery bridge
        // drains this identical tombstone set and routes an unacknowledged
        // record to `terminal.kill` too. `terminal.kill` is scheduled `fifo` and
        // `selectJob` returns null for fifo rather than joining an identical
        // queued job, so an unmediated duplicate is two real RPCs and two
        // `terminal.list` invalidations for one gesture - the second answering
        // `killed: false` about a session the first removed, which for a
        // `pendingCreate` record is the very answer the reprieve has to keep
        // treating as ambiguous.
        //
        // Variables built explicitly rather than passing the tombstone. The two
        // shapes were structurally identical until the tombstone grew
        // provenance, so this type-checked while quietly sending fields the RPC
        // has no use for.
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
  /**
   * The provider a session was opened to sign in to, already bound to
   * `activeHostId`. Injected for the same reason the legacy arm injects it:
   * `terminal.list` and the plain projection both carry the origin nowhere.
   */
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
        // Through the shared coordinator, never straight at the mutation. The
        // recovery bridge watches this same tombstone set and this same
        // projection, so a retained tombstone whose create lands late wakes
        // BOTH drains for one terminal. `terminal.plain.close` is fifo rather
        // than coalescing, so that is two real RPCs: the loser finds a terminal
        // the winner already removed and the mutation's `onError` raises
        // "Couldn't close the terminal." for a close that in fact succeeded.
        //
        // Retaining the tombstone here is what opened that window - it used to
        // be cleared on this pass, so it could never survive to be closed
        // twice. Joining does NOT stand in for sending it: the settlement
        // belongs to the request that ran, so the tombstone below clears only
        // for the owner, and a joiner leaves the record for the next pass.
        const outcome = await requestLandingTerminalClose({
          hostId: pending.hostId,
          sessionId: pending.sessionId,
          close: () =>
            args
              .closeTerminal({ terminalId: pending.sessionId })
              .then(() => undefined),
        });
        // Only the OWNER of the request may retire the record. The coordinator
        // keys by the terminal's lifetime, not by RPC, so this close can join an
        // in-flight `terminal.kill` - and that kill answers an already-gone
        // session with `killed: false`, which for a `pendingCreate` record the
        // kill mutation deliberately treats as "not created YET" and keeps the
        // tombstone for. Clearing on a joined promise would drop the record in
        // front of the PTY that create is about to produce.
        if (!outcome.owned) return;
      } else if (!absentListingProvesDeath(pending)) {
        // The close was never sent and absence proves nothing here - an
        // in-flight create is simply not projected yet, and a legacy session
        // never appears in a plain collection at all. Clearing regardless is how
        // the same tombstone was being discarded on a plain reconcile, not just
        // by the recovery bridge. Leave it for that bridge to drain.
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

  // A host-created sign-in session is manager-owned and import-exempt: it is
  // not legacy evidence, and `importLegacy` under its id would hand the plain
  // registry a session it never spawned. Its tab stays unacknowledged for
  // life and attaches through the legacy reattach path instead.
  //
  // The REGISTRY decides that, not the ref alone. A tab adopted while the host
  // still read `legacy` carries no marker, and after the capability switch it
  // is unacknowledged and unprojected - which is precisely the shape this
  // filter treats as legacy evidence.
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
