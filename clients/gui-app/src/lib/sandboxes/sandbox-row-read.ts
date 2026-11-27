import { queryOptions } from "@tanstack/react-query";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxListReadBoundary } from "@/hooks/sandboxes/use-sandbox-list-query";
import type { AuthService } from "@/lib/auth/auth-service";
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

/** Only the exact signed-in row or a typed absence can settle a known ID. */
async function readKnownSandboxRow(
  auth: AuthService,
  sandboxId: string,
  userId: string | null,
  scope: SandboxRowScope | null,
): Promise<SandboxRowRead | null> {
  if (userId === null || signedInUserId() !== userId) return null;
  const started = {
    sentAt: Date.now(),
    listReadBoundary: sandboxListReadBoundary(),
  };
  try {
    const result = await auth.getSandbox(sandboxId);
    if (signedInUserId() !== userId) return null;
    if (result.kind === "ok" && result.sandbox.id === sandboxId)
      return { ...started, row: result.sandbox };
    // The server masks team access loss as the same 404. Only a personal
    // lookup can prove absence without the authorization verdict for this GET.
    if (
      scope?.kind === "personal" &&
      result.kind === "refused" &&
      result.status === 404 &&
      result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
    )
      return { ...started, row: null };
  } catch {
    // An unreadable row is still unknown.
  }
  return { ...started, row: undefined };
}
