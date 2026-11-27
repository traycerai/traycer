import { queryOptions } from "@tanstack/react-query";
import type { SandboxGetFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxListResponse,
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

const listObservationIds = new WeakMap<SandboxListResponse, number>();
let nextListObservationId = 0;

export function sandboxListObservationId(
  list: SandboxListResponse | null | undefined,
): number | undefined {
  if (list === null || list === undefined) return undefined;
  const existing = listObservationIds.get(list);
  if (existing !== undefined) return existing;
  const id = ++nextListObservationId;
  listObservationIds.set(list, id);
  return id;
}

/** Keep an exact read scoped to the attempt and list answer that requested it. */
export function knownSandboxRowQueryOptions(
  input: Omit<SandboxKnownRowScope, "auth"> & {
    readonly auth: AuthService | null;
  },
) {
  const { auth, sandboxId, userId, omission } = input;
  return queryOptions({
    queryKey: sandboxQueryKeys.knownRow({ ...input, auth, sandboxId, userId }),
    gcTime: 0,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      auth === null || sandboxId === null
        ? Promise.resolve(null)
        : readKnownSandboxRow(auth, sandboxId, userId),
    enabled: auth !== null && sandboxId !== null && omission !== undefined,
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
): Promise<SandboxRowRead | null> {
  if (signedInUserId() !== userId) return null;
  const sentAt = Date.now();
  try {
    const result = await auth.getSandbox(sandboxId);
    if (signedInUserId() !== userId) return null;
    if (result.kind === "ok" && result.sandbox.id === sandboxId)
      return { row: result.sandbox, sentAt };
    if (sandboxRowNotFound(result)) return { row: null, sentAt };
  } catch {
    // An unreadable row is still unknown.
  }
  return null;
}
