import {
  CancelledError,
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import {
  currentAccountRequestOrder,
  nextAccountRequestOrder,
} from "@/lib/auth/verified-account-orders";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { recordListedDestroys } from "@/stores/sandboxes/ended-sandbox-hosts-store";

export interface SandboxListReadStart {
  readonly sentAt: number;
  readonly order: number;
}

const listReadStarts = new WeakMap<SandboxListResponse, SandboxListReadStart>();

export function sandboxListReadBoundary(): number {
  return currentAccountRequestOrder();
}

export function sandboxListReadStart(
  data: SandboxListResponse,
): SandboxListReadStart | undefined {
  return listReadStarts.get(data);
}

/** Orders requests started in this renderer, including reads in the same millisecond. */
export function sandboxListReadStartedAfter(
  data: SandboxListResponse,
  boundary: number,
): boolean {
  return (listReadStarts.get(data)?.order ?? 0) > boundary;
}

/** The exact query answer carries its request's send time, never its arrival time. */
export function sandboxListReadSentAt(
  data: SandboxListResponse | null | undefined,
): number | null {
  return data === null || data === undefined
    ? null
    : (listReadStarts.get(data)?.sentAt ?? null);
}

export function sandboxListQueryOptions(
  auth: Pick<AuthService, "listSandboxes" | "captureSandboxReadContext"> | null,
  userId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<SandboxListResponse | null>({
      queryKey: sandboxQueryKeys.listMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<SandboxListResponse | null>({
    queryKey: sandboxQueryKeys.list(auth, userId),
    queryFn: async (query) => {
      const current = auth.captureSandboxReadContext();
      const fetching = query.client
        .getQueryCache()
        .find({ queryKey: query.queryKey, exact: true });
      const sentAt = Date.now();
      const order = nextAccountRequestOrder();
      const result = await auth.listSandboxes().catch((error: unknown) => {
        if (current()) throw error;
        return null;
      });
      if (!current() || result === null) {
        if (!query.signal.aborted) void fetching?.cancel({ revert: true });
        throw new CancelledError({ revert: true });
      }
      if (result.kind === "ok") {
        listReadStarts.set(result.response, { sentAt, order });
        recordListedDestroys(result.response.sandboxes);
        return result.response;
      }
      // Thrown, never `{ sandboxes: [] }`: an empty list would read as "every
      // sandbox is gone", and the pickers and host list treat a missing
      // answer as unknown (they fail closed), which is the truth here.
      throw new Error(sandboxFailureMessage(result));
    },
    enabled,
    // The response identity owns its provenance, including identical-list refetches.
    structuralSharing: false,
    refetchOnWindowFocus: true,
  });
}

/**
 * `GET /api/sandboxes`: the signed-in user's sandboxes, which carry what the
 * host list does not - `burst`, shape, region and rate. Refreshed by the
 * directory's liveness tick (see `sandboxQueryKeys.list`).
 *
 * `data` is `undefined` until the first answer and stays at the last good
 * answer through a failed refetch; a surface that needs to know a sandbox is
 * NOT burst (every picker) must treat `undefined` as "not known", never as
 * "none are burst".
 */
export function useSandboxList(): UseQueryResult<SandboxListResponse | null> {
  return useObservedSandboxList(true);
}

export function useObservedSandboxList(
  enabled: boolean,
): UseQueryResult<SandboxListResponse | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  // A build that cannot reach the control plane reads nothing: its answer
  // stays "not known", so no picker or banner reports a failed list.
  const unavailable = useSandboxControlUnavailableReason() !== null;
  return useQuery(
    sandboxListQueryOptions(auth, userId, signedIn && !unavailable && enabled),
  );
}
