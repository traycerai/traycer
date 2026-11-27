import { queryOptions } from "@tanstack/react-query";
import type { SandboxGetFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import {
  nextAccountRequestOrder,
  readAccountOrders,
  type AccountOrders,
} from "@/lib/auth/verified-account-orders";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import {
  sandboxQueryKeys,
  type SandboxKnownRowScope,
} from "@/lib/query-keys/sandbox-query-keys";

export interface SandboxRowRead {
  /** `null` proves absence. `undefined` carries only the request's provenance. */
  readonly row: SandboxSummary | null | undefined;
  readonly sentAt: number;
  readonly listReadBoundary: number;
  /** A list row that started before this fence cannot overturn the observed loss. */
  readonly lossFence: number;
  /** A verification must have dispatched after this boundary to earn a probe. */
  readonly rejoinAfter?: number;
  readonly legacyPassive?: true;
  readonly legacyRouteUnavailable?: true;
  readonly probe?: true;
}

export type SandboxRowScope =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamId: string };

function scopeKey(scope: SandboxRowScope | null): string | null {
  if (scope === null) return null;
  return scope.kind === "personal" ? "personal" : `team:${scope.teamId}`;
}

interface KnownSandboxRowInput extends Omit<
  SandboxKnownRowScope,
  "auth" | "originalScope"
> {
  readonly auth: AuthService | null;
  readonly scope: SandboxRowScope | null;
  readonly pollWithoutRow: boolean;
  readonly canRead: boolean;
  readonly claimed: boolean;
  readonly routeRestored: boolean;
  readonly probeVerdict: number | null;
  readonly newerListedRow: boolean;
}

export function knownSandboxRowQueryOptions(input: KnownSandboxRowInput) {
  const { auth, sandboxId, hostId, userId, scope } = input;
  const queryKey = sandboxQueryKeys.knownRow({
    ...input,
    auth,
    sandboxId,
    hostId,
    userId,
    originalScope: scopeKey(scope),
  });
  return queryOptions<SandboxRowRead | null>({
    queryKey,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    ...(input.claimed && (!input.pollWithoutRow || input.probeVerdict !== null)
      ? { networkMode: "always" as const }
      : {}),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    structuralSharing: false,
    refetchInterval: (query) => {
      const read = query.state.data;
      const state = read?.row?.state;
      if (
        read?.rejoinAfter !== undefined ||
        read?.legacyPassive === true ||
        read?.row === null ||
        state === "failed" ||
        state === "destroying" ||
        state === "destroyed" ||
        (state === undefined && !input.pollWithoutRow)
      )
        return false;
      return 2_000;
    },
    queryFn: ({ client, queryKey: currentKey }) =>
      auth === null || sandboxId === null
        ? Promise.resolve(null)
        : readKnownSandboxRow({
            auth,
            sandboxId,
            hostId,
            userId,
            scope,
            claimed: input.claimed,
            previous: client.getQueryData<SandboxRowRead | null>(currentKey),
          }),
    enabled: (query) => {
      if (auth === null || sandboxId === null || !input.canRead) return false;
      const read = query.state.data;
      if (input.newerListedRow) return false;
      if (read?.rejoinAfter !== undefined) return input.probeVerdict !== null;
      if (read?.legacyPassive === true) return input.routeRestored;
      return true;
    },
  });
}

interface ExactSandboxRead {
  readonly auth: AuthService;
  readonly sandboxId: string;
  readonly hostId: string | null;
  readonly userId: string | null;
  readonly scope: SandboxRowScope | null;
  readonly claimed: boolean;
  readonly previous: SandboxRowRead | null | undefined;
}

export function sandboxRejoinVerdict(
  account: AccountOrders,
  teamId: string,
  userId: string | null,
  after: number,
): number | null {
  const { verdict, pending } = account;
  if (
    verdict === null ||
    verdict.userId !== userId ||
    verdict.dispatched <= after
  )
    return null;
  if (
    !verdict.teamIds.includes(teamId) ||
    pending.some((order) => order > verdict.dispatched)
  )
    return null;
  return verdict.verified;
}

/** Only the exact signed-in row or a typed absence can settle a known ID. */
async function readKnownSandboxRow(
  input: ExactSandboxRead,
): Promise<SandboxRowRead | null> {
  const { auth, sandboxId, hostId, userId, scope, previous } = input;
  if (userId === null || signedInUserId() !== userId) return null;
  const teamId = scope?.kind === "team" ? scope.teamId : null;
  const after = previous?.rejoinAfter;
  const isProbe = input.claimed && after !== undefined;
  if (isProbe && !probeStillAuthorized(auth, userId, teamId, after))
    return previous ?? null;
  const started = startSandboxRead(previous, isProbe);
  const result = await auth.getSandbox(sandboxId, teamId).catch(() => null);
  if (signedInUserId() !== userId) return null;
  const row = matchingSandboxRow(result, sandboxId, hostId);
  if (row !== null) return { ...started, row };
  if (sandboxNotFound(result)) {
    const absence = await observeSandboxAbsence(
      started,
      { auth, userId, scope, claimed: input.claimed },
      result.holdsTeam,
    );
    if (signedInUserId() !== userId) return null;
    if (absence !== undefined) return absence;
  }
  return isProbe
    ? { ...started, rejoinAfter: nextAccountRequestOrder() }
    : started;
}

function startSandboxRead(
  previous: SandboxRowRead | null | undefined,
  probe: boolean,
): SandboxRowRead {
  return {
    row: undefined,
    sentAt: Date.now(),
    listReadBoundary: nextAccountRequestOrder(),
    lossFence: previous?.lossFence ?? 0,
    ...(probe ? { probe: true } : {}),
  };
}

function probeStillAuthorized(
  auth: AuthService,
  userId: string,
  teamId: string | null,
  after: number,
): boolean {
  return (
    teamId !== null &&
    sandboxRejoinVerdict(readAccountOrders(auth), teamId, userId, after) !==
      null
  );
}

function matchingSandboxRow(
  result: SandboxGetFetchResult | null,
  sandboxId: string,
  hostId: string | null,
): SandboxSummary | null {
  if (result?.kind !== "ok" || result.sandbox.id !== sandboxId) return null;
  return hostId === null || result.sandbox.hostId === hostId
    ? result.sandbox
    : null;
}

async function observeSandboxAbsence(
  started: SandboxRowRead,
  input: {
    readonly auth: AuthService;
    readonly userId: string;
    readonly scope: SandboxRowScope | null;
    readonly claimed: boolean;
  },
  witness: boolean | undefined,
): Promise<SandboxRowRead | undefined> {
  const { auth, userId, scope, claimed } = input;
  if (scope?.kind === "personal") return { ...started, row: null };
  if (scope?.kind !== "team") return undefined;
  if (witness === true) return { ...started, row: null };
  if (witness === false) return parkOnLoss(started, started.probe === true);
  if (!claimed || started.probe === true) return undefined;
  const holdsTeam = await verifyTeamAfter(
    auth,
    userId,
    scope.teamId,
    nextAccountRequestOrder(),
  );
  return holdsTeam === false
    ? parkOnLoss(started, true)
    : { ...started, legacyPassive: true };
}

function parkOnLoss(
  read: SandboxRowRead,
  requirePostLossVerification: boolean,
): SandboxRowRead {
  const fence = nextAccountRequestOrder();
  return {
    ...read,
    lossFence: fence,
    rejoinAfter: requirePostLossVerification ? fence : read.listReadBoundary,
  };
}

function sandboxNotFound(
  result: SandboxGetFetchResult | null,
): result is Extract<SandboxGetFetchResult, { kind: "refused" }> & {
  readonly status: 404;
  readonly code: typeof SANDBOX_REFUSAL_CODE_NOT_FOUND;
} {
  return (
    result?.kind === "refused" &&
    result.status === 404 &&
    result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
  );
}

/** Revalidation queues behind any older in-flight account check. */
async function verifyTeamAfter(
  auth: AuthService,
  userId: string,
  teamId: string,
  after: number,
): Promise<boolean | undefined> {
  // This call uses the auth transport's bounded retries. An older verification
  // may finish while it queues, but its dispatch cannot satisfy this boundary.
  await auth.revalidateCurrentContextAfterInvalidation().catch(() => null);
  if (signedInUserId() !== userId) return undefined;
  const { verdict } = readAccountOrders(auth);
  return verdict?.userId === userId && verdict.dispatched > after
    ? verdict.teamIds.includes(teamId)
    : undefined;
}
