import { queryOptions } from "@tanstack/react-query";
import type { SandboxGetFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxListReadBoundary } from "@/hooks/sandboxes/use-sandbox-list-query";
import type { AuthService } from "@/lib/auth/auth-service";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import { useAuthStore, type EpicShareableTeam } from "@/stores/auth/auth-store";
import {
  sandboxQueryKeys,
  type SandboxKnownRowScope,
} from "@/lib/query-keys/sandbox-query-keys";

export interface SandboxRowRead {
  /** `null` proves absence. `undefined` carries only the request's provenance. */
  readonly row: SandboxSummary | null | undefined;
  readonly sentAt: number;
  readonly listReadBoundary: number;
  readonly teamAccessLost?: {
    readonly teamId: string;
    readonly fence: number;
    /** A later projection of the account verdict may re-arm this read. */
    readonly earlierVerdict: ReadonlyArray<EpicShareableTeam>;
  };
}

export type SandboxRowScope =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamId: string };

function scopeKey(scope: SandboxRowScope | null): string | null {
  if (scope === null) return null;
  return scope.kind === "personal" ? "personal" : `team:${scope.teamId}`;
}

export function sandboxRowReadParked(
  read: SandboxRowRead | null | undefined,
  teams: ReadonlyArray<EpicShareableTeam> | null,
): boolean {
  const loss = read?.teamAccessLost;
  return (
    loss !== undefined &&
    (teams === null ||
      teams === loss.earlierVerdict ||
      !teams.some((team) => team.teamId === loss.teamId))
  );
}

/** Equivalent omissions share one read until its attempt or original scope changes. */
export function knownSandboxRowQueryOptions(
  input: Omit<SandboxKnownRowScope, "auth" | "originalScope"> & {
    readonly auth: AuthService | null;
    readonly scope: SandboxRowScope | null;
    readonly teams: ReadonlyArray<EpicShareableTeam> | null;
    readonly pollWithoutRow: boolean;
    readonly canRead: boolean;
  },
) {
  const {
    auth,
    sandboxId,
    hostId,
    userId,
    scope,
    teams,
    pollWithoutRow,
    canRead,
  } = input;
  return queryOptions({
    queryKey: sandboxQueryKeys.knownRow({
      ...input,
      auth,
      sandboxId,
      hostId,
      userId,
      originalScope: scopeKey(scope),
    }),
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    // The parked read uses the actual projection's identity to detect a new verdict.
    structuralSharing: false,
    refetchInterval: (query) => {
      const read = query.state.data;
      const state = read?.row?.state;
      if (
        sandboxRowReadParked(read, teams) ||
        read?.row === null ||
        state === "failed" ||
        state === "destroying" ||
        state === "destroyed" ||
        (state === undefined && !pollWithoutRow)
      )
        return false;
      return 2_000;
    },
    queryFn: () =>
      auth === null || sandboxId === null
        ? Promise.resolve(null)
        : readKnownSandboxRow({ auth, sandboxId, hostId, userId, scope }),
    enabled: (query) =>
      auth !== null &&
      sandboxId !== null &&
      canRead &&
      !sandboxRowReadParked(query.state.data, teams),
  });
}

/** Only the exact signed-in row or a typed absence can settle a known ID. */
export async function readKnownSandboxRow(input: {
  readonly auth: AuthService;
  readonly sandboxId: string;
  readonly hostId: string | null;
  readonly userId: string | null;
  readonly scope: SandboxRowScope | null;
}): Promise<SandboxRowRead | null> {
  const { auth, sandboxId, hostId, userId, scope } = input;
  if (userId === null || signedInUserId() !== userId) return null;
  const current = input.auth.captureSandboxReadContext();
  const started = {
    sentAt: Date.now(),
    listReadBoundary: sandboxListReadBoundary(),
  };
  const teamId = scope?.kind === "team" ? scope.teamId : null;
  const result = await auth.getSandbox(sandboxId, teamId).catch(() => null);
  if (!current() || signedInUserId() !== userId) return null;
  const row = matchingLegacySandboxRow(result, sandboxId, hostId);
  if (row !== null) return { ...started, row };
  if (sandboxNotFound(result)) {
    if (scope?.kind === "personal") return { ...started, row: null };
    if (teamId !== null) {
      const absence = await readTeamAbsence(
        auth,
        userId,
        teamId,
        result.holdsTeam,
      );
      return current() ? { ...started, ...absence } : null;
    }
  }
  return { ...started, row: undefined };
}

function matchingLegacySandboxRow(
  result: SandboxGetFetchResult | null,
  sandboxId: string,
  hostId: string | null,
): SandboxSummary | null {
  if (result?.kind !== "ok" || result.sandbox.id !== sandboxId) return null;
  return hostId === null || result.sandbox.hostId === hostId
    ? result.sandbox
    : null;
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

async function readTeamAbsence(
  auth: AuthService,
  userId: string,
  teamId: string,
  holdsTeam: boolean | undefined,
): Promise<Pick<SandboxRowRead, "row" | "teamAccessLost">> {
  if (holdsTeam === true) return { row: null };
  if (holdsTeam === false || (await teamAccessLost(auth, userId, teamId)))
    return {
      row: undefined,
      teamAccessLost: {
        teamId,
        fence: sandboxListReadBoundary(),
        earlierVerdict: useAuthStore.getState().shareableTeams,
      },
    };
  return { row: undefined };
}

/** A separate verdict can pause an uncertain send. Only the GET proves absence. */
async function teamAccessLost(
  auth: AuthService,
  userId: string,
  teamId: string,
): Promise<boolean> {
  const user = await auth.fetchAuthenticatedUser();
  return (
    signedInUserId() === userId &&
    user?.user.id === userId &&
    !user.teamSubscriptions.some((entry) => entry.team.id === teamId)
  );
}
