import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  terminalSessionKey,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";
import { reconcileLandingTerminalTabs } from "./landing-terminal-reconciliation";
import type { LandingTerminalAvailability } from "./landing-terminal-availability";
import type { LandingTerminalKillVariables } from "./use-landing-terminal-kill-mutation";

const INDEPENDENT_SCOPE = { kind: "independent" } as const;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
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
  readonly activeHostId: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly panelOpen: boolean;
  readonly primaryWorkspacePath: string | null;
  readonly client: HostClient<HostRpcRegistry>;
  readonly killTerminal: (
    variables: LandingTerminalKillVariables,
  ) => Promise<unknown>;
  readonly onReconciled: (hostId: string) => void;
  /**
   * Runs after a reconciliation generation has fully applied (store updated,
   * host id published). The panel owns what happens next - auto-spawning into
   * an empty panel and honoring a pending open-gesture's pinned-folder intent -
   * so those decisions always act on reconciled truth, never a stale cache.
   */
  readonly onSettled: () => void;
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
 * classify a session, clear a tombstone, adopt an orphan, or auto-spawn.
 */
export function useLandingTerminalReconciliation(
  args: LandingTerminalReconciliationArgs,
): void {
  const {
    activeHostId,
    availability,
    panelOpen,
    primaryWorkspacePath,
    client,
    killTerminal,
    onReconciled,
    onSettled,
  } = args;
  const queryClient = useQueryClient();
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const reconciliationRef = useRef<string | null>(null);

  useEffect(() => {
    return client.onChange((event) => {
      if (event.currentHostId !== activeHostId) return;
      if (
        event.reason === "availability-recovered" ||
        event.reason === "host-updated" ||
        event.reason === "host-bound"
      ) {
        setConnectionEpoch((current) => current + 1);
      }
    });
  }, [activeHostId, client]);

  useEffect(() => {
    if (activeHostId === null || availability !== "supported") {
      return;
    }
    const reconciliationKey = [
      activeHostId,
      panelOpen ? "open" : "closed",
      primaryWorkspacePath ?? "no-workspace",
      connectionEpoch,
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
        isAborted(controller.signal) ||
        client.getActiveHostId() !== activeHostId
      ) {
        releaseLatch();
        return;
      }
      const freshSessions = await queryClient.fetchQuery(listQuery).then(
        (response) => response.sessions,
        () => null,
      );
      if (
        isAborted(controller.signal) ||
        client.getActiveHostId() !== activeHostId ||
        freshSessions === null
      ) {
        releaseLatch();
        return;
      }

      const initial = useLandingTerminalStore.getState();
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
      for (const pending of hostTombstones) {
        if (!listedSessionIds.has(pending.sessionId)) {
          useLandingTerminalStore
            .getState()
            .clearPendingKill(pending.hostId, pending.sessionId);
        }
      }
      await Promise.all(
        hostTombstones
          .filter((pending) => listedSessionIds.has(pending.sessionId))
          .map((pending) =>
            killTerminal(pending).then(
              () => undefined,
              () => undefined,
            ),
          ),
      );
      if (isAborted(controller.signal)) {
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
      });
      current.applyReconciliation(
        reconciliation.tabs,
        reconciliation.activeInstanceId,
        reconciliation.collapseWhenEmpty,
      );
      onReconciled(activeHostId);
      onSettled();
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
    killTerminal,
    onReconciled,
    onSettled,
    panelOpen,
    primaryWorkspacePath,
    queryClient,
  ]);
}
