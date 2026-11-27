import { queryOptions } from "@tanstack/react-query";
import type { SandboxGetFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import {
  sandboxQueryKeys,
  type SandboxKnownRowScope,
} from "@/lib/query-keys/sandbox-query-keys";

export interface SandboxRowRead {
  readonly row: SandboxSummary | null;
  readonly sentAt: number;
}

export type SandboxRowScope =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamId: string };

function scopeKey(scope: SandboxRowScope | null): string | null {
  if (scope === null) return null;
  return scope.kind === "personal" ? "personal" : `team:${scope.teamId}`;
}

/** Equivalent omissions share one read until its attempt or original scope changes. */
export function knownSandboxRowQueryOptions(
  input: Omit<SandboxKnownRowScope, "auth" | "originalScope"> & {
    readonly auth: AuthService | null;
    readonly scope: SandboxRowScope | null;
  },
) {
  const { auth, sandboxId, userId, omitted, scope } = input;
  return queryOptions({
    queryKey: sandboxQueryKeys.knownRow({
      ...input,
      auth,
      sandboxId,
      userId,
      originalScope: scopeKey(scope),
    }),
    gcTime: 0,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.row === null ? false : 2_000,
    queryFn: () =>
      auth === null || sandboxId === null
        ? Promise.resolve(null)
        : readKnownSandboxRow(auth, sandboxId, userId, scope),
    enabled: auth !== null && sandboxId !== null && omitted,
  });
}

function sandboxRowNotFound(result: SandboxGetFetchResult): boolean {
  return (
    result.kind === "refused" &&
    result.status === 404 &&
    result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
  );
}

/** Only the exact signed-in row or a typed absence can settle a known ID. */
async function readKnownSandboxRow(
  auth: AuthService,
  sandboxId: string,
  userId: string | null,
  scope: SandboxRowScope | null,
): Promise<SandboxRowRead | null> {
  if (userId === null || signedInUserId() !== userId) return null;
  const sentAt = Date.now();
  try {
    const result = await auth.getSandbox(sandboxId);
    if (signedInUserId() !== userId) return null;
    if (result.kind === "ok" && result.sandbox.id === sandboxId)
      return { row: result.sandbox, sentAt };
    if (
      sandboxRowNotFound(result) &&
      (await maySettleSandboxAbsence(auth, userId, scope))
    )
      return { row: null, sentAt };
  } catch {
    // An unreadable row is still unknown.
  }
  return null;
}

async function maySettleSandboxAbsence(
  auth: AuthService,
  userId: string,
  scope: SandboxRowScope | null,
): Promise<boolean> {
  if (scope === null) return false;
  if (scope.kind === "personal") return signedInUserId() === userId;
  const user = await auth.fetchAuthenticatedUser();
  return (
    signedInUserId() === userId &&
    user?.user.id === userId &&
    user.teamSubscriptions.some(
      (subscription) => subscription.team.id === scope.teamId,
    )
  );
}
