import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  SandboxListResponse,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { SANDBOX_REFUSAL_CODE_NOT_FOUND } from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import {
  nextAccountRequestOrder,
  subscribeAccountOrders,
} from "@/lib/auth/verified-account-orders";
import {
  sandboxListObservation,
  useObservedSandboxList,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import type { SandboxRowScope } from "@/lib/sandboxes/sandbox-row-read";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import { sandboxQueryKeys } from "@/lib/query-keys";
import {
  initialClaimedSandboxEvidence,
  reduceClaimedSandboxEvidence,
  type ClaimedSandboxDecision,
  type ClaimedSandboxEvent,
  type ClaimedSandboxExactOutcome,
} from "@/lib/sandboxes/claimed-sandbox-evidence";

interface ClaimIdentity {
  readonly id: string;
  readonly sandboxId: string;
  readonly hostId: string;
  readonly userId: string | null;
  readonly scope: SandboxRowScope | null;
}

interface ClaimObservationInput extends ClaimIdentity {
  readonly auth: AuthService | null;
  readonly era: string | null;
  readonly active: () => boolean;
  readonly liveRoute: boolean;
  readonly boundary: number | undefined;
}

interface ClaimObservation {
  readonly decision: ClaimedSandboxDecision;
  readonly canContinue: () => boolean;
  readonly captureWakeCompletion: () => () => boolean;
  readonly isDecisionCurrent: () => boolean;
  readonly refetch: () => Promise<void>;
}

interface ClaimReader {
  readonly identity: ClaimObservationInput;
  readonly store: StoreApi<ClaimedSandboxDecision>;
  readonly feed: (event: ClaimedSandboxEvent) => void;
}

function createClaimReader(input: ClaimObservationInput): ClaimReader {
  const state = initialClaimedSandboxEvidence({
    sandboxId: input.sandboxId,
    hostId: input.hostId,
    userId: input.userId ?? "",
    teamId: input.scope?.kind === "team" ? input.scope.teamId : null,
    personalScope: input.scope?.kind === "personal",
    liveRoute: input.liveRoute,
    boundary: input.boundary ?? 0,
  });
  const store = createStore(() =>
    reduceClaimedSandboxEvidence(state, {
      kind: "route",
      live: input.liveRoute,
    }),
  );
  return {
    identity: input,
    store,
    feed: (event) =>
      store.setState((previous) => {
        const next = reduceClaimedSandboxEvidence(previous.state, event);
        return next.state === previous.state ? previous : next;
      }, true),
  };
}

export function useClaimSandboxReadEra(
  auth: AuthService | null,
): string | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      auth?.subscribeSandboxReadEra(listener) ?? (() => {}),
    [auth],
  );
  const snapshot = useCallback(() => auth?.getSandboxReadEra() ?? null, [auth]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useClaimedSandboxEvidence(
  input: ClaimObservationInput,
): ClaimObservation {
  // The owner drives one reader. A replacement dispatch remounts that owner.
  const [reader] = useState(() => createClaimReader(input));
  const queryClient = useQueryClient();
  const decision = useStore(reader.store);
  const list = useObservedSandboxList(
    decision.observeList && input.boundary !== undefined,
  );
  const { auth, era } = input;
  const isCurrent = useCallback(
    () =>
      era !== null &&
      auth?.getSandboxReadEra() === era &&
      reader.identity.active() &&
      signedInUserId() === input.userId,
    [auth, era, input.userId, reader],
  );
  const refetchList = list.refetch;
  const refetch = useCallback(async () => {
    if (!isCurrent() || !reader.store.getState().observeList) return;
    await refetchList({ cancelRefetch: false });
  }, [reader, refetchList, isCurrent]);
  const canContinue = useCallback(() => {
    const latest = reader.store.getState();
    return isCurrent() && !latest.passive && !latest.state.retired;
  }, [reader, isCurrent]);
  const captureWakeCompletion = useCallback(() => {
    const fence = reader.store.getState().state.lossFence;
    return () =>
      canContinue() && reader.store.getState().state.lossFence === fence;
  }, [reader, canContinue]);
  const listKey = useMemo(
    () =>
      input.auth === null
        ? sandboxQueryKeys.listMissing()
        : sandboxQueryKeys.list(input.auth, input.userId),
    [input.auth, input.userId],
  );

  useEffect(() => {
    reader.feed({ kind: "route", live: input.liveRoute });
  }, [reader, input.liveRoute]);
  useEffect(() => {
    if (input.boundary !== undefined)
      reader.feed({ kind: "boundary", at: input.boundary });
  }, [reader, input.boundary]);
  useEffect(() => {
    if (auth === null) return;
    return subscribeAccountOrders(auth, (account) => {
      if (isCurrent()) reader.feed({ kind: "account", account });
    });
  }, [reader, auth, isCurrent]);
  useSharedClaimList({ queryClient, listKey, reader, list, isCurrent, era });
  useClaimReadEffects(reader, input, isCurrent, decision.read);
  const isDecisionCurrent = useCallback(
    () => isCurrent() && reader.store.getState() === decision,
    [isCurrent, reader, decision],
  );
  return {
    decision,
    canContinue,
    captureWakeCompletion,
    isDecisionCurrent,
    refetch,
  };
}

function useSharedClaimList(input: {
  readonly queryClient: QueryClient;
  readonly listKey: readonly unknown[];
  readonly reader: ClaimReader;
  readonly era: string | null;
  readonly list: {
    readonly data: SandboxListResponse | null | undefined;
    readonly error: unknown;
    readonly isFetching: boolean;
    readonly fetchStatus: string;
  };
  readonly isCurrent: () => boolean;
}): void {
  const { queryClient, listKey, reader, isCurrent, list, era } = input;
  const seen = useRef<number | null>(null);
  const feed = useCallback(
    (
      response: SandboxListResponse | null | undefined,
      error: unknown,
      pending: boolean,
    ) => {
      if (!isCurrent()) return;
      if (pending) {
        reader.feed({ kind: "list-start" });
        return;
      }
      const result = error ?? response;
      const observation = sandboxListObservation(result);
      if (
        observation !== undefined &&
        observation.era === era &&
        seen.current !== observation.order
      ) {
        seen.current = observation.order;
        reader.feed({
          kind: "list-result",
          answer: {
            order: observation.order,
            sentAt: observation.sentAt,
            row: findListedClaimRow(
              reader.identity,
              result === response ? response : null,
            ),
          },
        });
      } else {
        reader.feed({ kind: "list-idle" });
      }
    },
    [era, isCurrent, reader],
  );
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type !== "updated" ||
          event.query !==
            queryClient.getQueryCache().find({ queryKey: listKey, exact: true })
        )
          return;
        const state = queryClient.getQueryState<SandboxListResponse | null>(
          listKey,
        );
        if (state)
          feed(
            state.data,
            state.status === "error" ? state.error : null,
            state.fetchStatus === "fetching",
          );
      }),
    [queryClient, listKey, feed],
  );
  const { data, isFetching, fetchStatus, error } = list;
  useEffect(() => {
    if (
      isFetching ||
      data !== undefined ||
      Boolean(error) ||
      fetchStatus === "idle"
    )
      feed(data, error, isFetching);
  }, [feed, data, error, isFetching, fetchStatus]);
}

function findListedClaimRow(
  identity: ClaimIdentity,
  response: SandboxListResponse | null | undefined,
): SandboxSummary | null {
  return (
    response?.sandboxes.find(
      (item) =>
        item.id === identity.sandboxId && item.hostId === identity.hostId,
    ) ?? null
  );
}

function useClaimReadEffects(
  reader: ClaimReader,
  input: Pick<ClaimObservationInput, "auth" | "boundary">,
  isCurrent: () => boolean,
  requested: ClaimedSandboxDecision["read"],
): void {
  const { auth, boundary } = input;
  const lifetimeRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;
    return () => lifetime.abort();
  }, [reader, isCurrent]);
  useEffect(() => {
    const lifetime = lifetimeRef.current;
    if (
      requested === null ||
      auth === null ||
      boundary === undefined ||
      lifetime === null
    )
      return;
    const current = () => !lifetime.signal.aborted && isCurrent();
    void Promise.resolve().then(() => {
      if (!current() || requested !== reader.store.getState().read) return;
      switch (requested) {
        case "bootstrap":
          return readBootstrapList(reader, auth, current);
        case "access":
          return readClaimAccess(reader, auth, current);
        case "exact":
        case "probe":
          return readClaimRow(reader, auth, current, requested === "probe");
      }
    });
  }, [reader, auth, boundary, isCurrent, requested]);
}

async function readBootstrapList(
  reader: ClaimReader,
  auth: AuthService,
  current: () => boolean,
): Promise<void> {
  reader.feed({ kind: "bootstrap-start" });
  const sentAt = Date.now();
  const order = nextAccountRequestOrder();
  const result = await auth.listSandboxes().catch(() => null);
  if (!current()) return;
  reader.feed({
    kind: "bootstrap-result",
    answer: {
      row: findListedClaimRow(
        reader.identity,
        result?.kind === "ok" ? result.response : null,
      ),
      sentAt,
      order,
    },
  });
}

async function readClaimRow(
  reader: ClaimReader,
  auth: AuthService,
  current: () => boolean,
  probe: boolean,
): Promise<void> {
  const order = nextAccountRequestOrder();
  const sentAt = Date.now();
  reader.feed({ kind: "exact-start", request: { order, probe } });
  const outcome = await readClaimOutcome(reader.identity, auth, current, {
    order,
    sentAt,
  });
  if (outcome === null || !current()) return;
  reader.feed({
    kind: "exact-result",
    order,
    finished: nextAccountRequestOrder(),
    outcome,
  });
}

async function readClaimOutcome(
  identity: ClaimIdentity,
  auth: AuthService,
  current: () => boolean,
  request: {
    readonly order: number;
    readonly sentAt: number;
  },
): Promise<ClaimedSandboxExactOutcome | null> {
  const { scope, sandboxId } = identity;
  const teamId = scope?.kind === "team" ? scope.teamId : null;
  const result = await auth.getSandbox(sandboxId, teamId).catch(() => null);
  if (!current()) return null;
  if (result?.kind === "ok") {
    const row: SandboxSummary = result.sandbox;
    return {
      kind: "row",
      row: {
        row,
        order: request.order,
        sentAt: request.sentAt,
        source: "exact",
      },
    };
  }
  return result?.kind === "refused" &&
    result.status === 404 &&
    result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
    ? { kind: "not-found", sentAt: request.sentAt, holdsTeam: result.holdsTeam }
    : { kind: "inconclusive" };
}

async function readClaimAccess(
  reader: ClaimReader,
  auth: AuthService,
  current: () => boolean,
): Promise<void> {
  reader.feed({ kind: "access-start" });
  const { userId, teamId } = reader.store.getState().state;
  const holdsTeam =
    teamId === null
      ? undefined
      : await auth.readSandboxTeamAccess(userId, teamId).catch(() => undefined);
  if (!current()) return;
  reader.feed({
    kind: "access-result",
    holdsTeam,
    finished: nextAccountRequestOrder(),
  });
}
