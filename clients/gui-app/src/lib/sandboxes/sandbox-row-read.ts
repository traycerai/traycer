import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { SandboxGetFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxCreateRequest,
  type SandboxListResponse,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import { sandboxRetryFromRow } from "@/lib/sandboxes/sandbox-create-key";
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

interface KnownSandboxRowAnswer {
  readonly omission: number | undefined;
  readonly read: SandboxRowRead | null;
}

export function sandboxRowDestroySettled(
  row: SandboxSummary | null | undefined,
  hostId: string | null,
): boolean {
  return row?.state === "destroyed" && row.hostId === hostId;
}

/** A recorded destroy is final for that row. Other answers need the current list observation. */
export function knownSandboxRowCurrent(
  answer: KnownSandboxRowAnswer,
  omission: number | undefined,
  hostId: string | null,
): boolean {
  return (
    answer.omission === omission ||
    sandboxRowDestroySettled(answer.read?.row, hostId)
  );
}

/** Omissions request a read without changing the scope of one already in flight. */
export function knownSandboxRowQueryOptions(
  input: Omit<SandboxKnownRowScope, "auth"> & {
    readonly auth: AuthService | null;
    readonly omission: number | undefined;
  },
) {
  const { auth, sandboxId, userId, omission } = input;
  return queryOptions({
    queryKey: sandboxQueryKeys.knownRow({ ...input, auth, sandboxId, userId }),
    gcTime: 0,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    meta: { omission },
    queryFn: async ({ meta }): Promise<KnownSandboxRowAnswer> => ({
      omission: typeof meta?.omission === "number" ? meta.omission : undefined,
      read:
        auth === null || sandboxId === null
          ? null
          : await readKnownSandboxRow(auth, sandboxId, userId),
    }),
    enabled: auth !== null && sandboxId !== null && omission !== undefined,
  });
}

export async function cancelSandboxWakeReads(
  client: QueryClient,
  auth: AuthService,
  userId: string | null,
  knownRowKey: QueryKey,
): Promise<void> {
  await Promise.all([
    client.cancelQueries({ queryKey: knownRowKey, exact: true }),
    client.cancelQueries({
      queryKey: sandboxQueryKeys.list(auth, userId),
      exact: true,
    }),
  ]);
}

export function sandboxRowNotFound(result: SandboxGetFetchResult): boolean {
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

export async function readSandboxRetryCreate(
  auth: AuthService,
  sandboxId: string,
  userId: string | null,
): Promise<SandboxCreateRequest | null> {
  const read = await readKnownSandboxRow(auth, sandboxId, userId);
  return sandboxRetryFromRow(sandboxId, read?.row);
}
