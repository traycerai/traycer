import type { SandboxGetFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  readAccountOrders,
  subscribeAccountOrders,
} from "@/lib/auth/verified-account-orders";
import {
  sandboxListReadSentAt,
  sandboxListReadStart,
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
  type ClaimedSandboxRow,
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

const claimObservations = createStore(
  () => new Map<string, ClaimObservation>(),
);

export function usePublishedClaimEvidence(
  id: string,
): ClaimObservation | undefined {
  return useStore(claimObservations, (state) => state.get(id));
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
  const isCurrent = useMemo(() => {
    const context = input.auth?.captureSandboxReadContext();
    return () =>
      context?.() === true &&
      reader.identity.active() &&
      signedInUserId() === input.userId;
  }, [input.auth, input.userId, reader]);
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
  const auth = input.auth;
  useEffect(() => {
    if (auth === null) return;
    return subscribeAccountOrders(auth, (account) => {
      if (isCurrent()) reader.feed({ kind: "account", account });
    });
  }, [reader, auth, isCurrent]);
  useSharedClaimList({ queryClient, listKey, reader, list, isCurrent });
  useClaimReadEffects(reader, input, isCurrent, decision.read);
  const isDecisionCurrent = useCallback(
    () => isCurrent() && reader.store.getState() === decision,
    [isCurrent, reader, decision],
  );
  const observation = useMemo(
    () => ({
      decision,
      canContinue,
      captureWakeCompletion,
      isDecisionCurrent,
      refetch,
    }),
    [decision, canContinue, captureWakeCompletion, isDecisionCurrent, refetch],
  );
  useEffect(() => {
    claimObservations.setState(
      (previous) => new Map(previous).set(input.id, observation),
      true,
    );
    return () => {
      claimObservations.setState((previous) => {
        if (previous.get(input.id) !== observation) return previous;
        const next = new Map(previous);
        next.delete(input.id);
        return next;
      }, true);
    };
  }, [input.id, observation]);
  return observation;
}

function useSharedClaimList(input: {
  readonly queryClient: QueryClient;
  readonly listKey: readonly unknown[];
  readonly reader: ClaimReader;
  readonly list: {
    readonly data: SandboxListResponse | null | undefined;
    readonly isError: boolean;
    readonly isFetching: boolean;
    readonly fetchStatus: string;
  };
  readonly isCurrent: () => boolean;
}): void {
  const { queryClient, listKey, reader, isCurrent, list } = input;
  const seen = useRef<{
    data: SandboxListResponse | null | undefined;
    failed: boolean;
    pending: boolean;
  } | null>(null);
  const feed = useCallback(
    (
      data: SandboxListResponse | null | undefined,
      failed: boolean,
      pending: boolean,
    ) => {
      if (!isCurrent()) return;
      const last = seen.current;
      if (
        last !== null &&
        last.data === data &&
        last.failed === failed &&
        last.pending === pending
      )
        return;
      seen.current = { data, failed, pending };
      if (pending) reader.feed({ kind: "list-start" });
      else
        reader.feed({
          kind: "list-result",
          row: failed ? null : listedRow(reader.identity, data),
        });
    },
    [reader, isCurrent],
  );
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        if (
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
            state.status === "error",
            state.fetchStatus === "fetching",
          );
      }),
    [queryClient, listKey, feed],
  );
  // Also admit any current answer already in the shared cache when we mount.
  const { data, isError, isFetching, fetchStatus } = list;
  useEffect(() => {
    if (isFetching || data !== undefined || isError || fetchStatus === "idle")
      feed(data, isError, isFetching);
  }, [feed, data, isError, isFetching, fetchStatus]);
}

function listedRow(
  identity: ClaimIdentity,
  response: SandboxListResponse | null | undefined,
): ClaimedSandboxRow | null {
  const row = response?.sandboxes.find(
    (item) => item.id === identity.sandboxId && item.hostId === identity.hostId,
  );
  if (row === undefined || response === undefined || response === null)
    return null;
  const at = sandboxListReadStart(response);
  const sentAt = at?.sentAt ?? sandboxListReadSentAt(response);
  return sentAt === null
    ? null
    : {
        row,
        sentAt,
        order: at?.order ?? nextAccountRequestOrder(),
        source: "list",
      };
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
      return requested === "bootstrap"
        ? readBootstrapList(reader, auth, current)
        : readClaimRow(reader, auth, current, requested === "probe");
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
  const row =
    result?.kind === "ok"
      ? result.response.sandboxes.find(
          (item) =>
            item.id === reader.identity.sandboxId &&
            item.hostId === reader.identity.hostId,
        )
      : undefined;
  reader.feed({
    kind: "bootstrap-result",
    row: row === undefined ? null : { row, sentAt, order, source: "list" },
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
    probe,
  });
  if (outcome === null || !current()) {
    reader.feed({ kind: "retire" });
    return;
  }
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
    readonly probe: boolean;
  },
): Promise<ClaimedSandboxExactOutcome | null> {
  const { scope, sandboxId, hostId, userId } = identity;
  const teamId = scope?.kind === "team" ? scope.teamId : null;
  const result = await auth.getSandbox(sandboxId, teamId).catch(() => null);
  if (!current()) return null;
  if (result?.kind === "ok") {
    const row: SandboxSummary = result.sandbox;
    return row.id === sandboxId && row.hostId === hostId
      ? {
          kind: "row",
          row: {
            row,
            order: request.order,
            sentAt: request.sentAt,
            source: "exact",
          },
        }
      : { kind: "inconclusive" };
  }
  return readClaimAbsence(result, { scope, userId, auth, current, request });
}

function readClaimAbsence(
  result: SandboxGetFetchResult | null,
  input: {
    readonly scope: SandboxRowScope | null;
    readonly userId: string | null;
    readonly auth: AuthService;
    readonly current: () => boolean;
    readonly request: {
      readonly order: number;
      readonly sentAt: number;
      readonly probe: boolean;
    };
  },
): ClaimedSandboxExactOutcome | Promise<ClaimedSandboxExactOutcome | null> {
  const { scope, userId, auth, current, request } = input;
  const teamId = scope?.kind === "team" ? scope.teamId : null;
  if (
    result?.kind !== "refused" ||
    result.status !== 404 ||
    result.code !== SANDBOX_REFUSAL_CODE_NOT_FOUND
  )
    return { kind: "inconclusive" };
  if (
    scope?.kind === "personal" ||
    (teamId !== null && result.holdsTeam === true)
  )
    return {
      kind: "row",
      row: {
        row: null,
        order: request.order,
        sentAt: request.sentAt,
        source: "exact",
      },
    };
  if (teamId === null) return { kind: "inconclusive" };
  if (result.holdsTeam === false) return { kind: "lost", witness: "exact" };
  if (request.probe) return { kind: "inconclusive" };
  return verifyClaimTeam(auth, current, userId, teamId);
}

async function verifyClaimTeam(
  auth: AuthService,
  current: () => boolean,
  userId: string | null,
  teamId: string,
): Promise<ClaimedSandboxExactOutcome | null> {
  const after = nextAccountRequestOrder();
  await auth.revalidateSandboxReadContext(current).catch(() => undefined);
  if (!current()) return null;
  const { verdict } = readAccountOrders(auth);
  return verdict?.userId === userId &&
    verdict.dispatched > after &&
    !verdict.teamIds.includes(teamId)
    ? { kind: "lost", witness: "account" }
    : { kind: "legacy-passive" };
}
