import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { UserSandboxCost } from "@traycer/protocol/host/sandbox-control";
import {
  SupersededAuthEraError,
  type AuthService,
} from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { SANDBOX_COST_REFRESH_MS } from "@/hooks/sandboxes/refresh-sandbox-cost-queries";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";

/**
 * What the user's sandboxes accrue now, all rows together: compute while
 * awake, and storage while suspended or stopped. The awake burn alone is not
 * it - a sleeping sandbox burns nothing yet still bills its disk, so its
 * storage figure, pending charges and the balance would go stale.
 */
function accruingMillicreditsPerHour(costs: UserSandboxCost): number {
  return costs.sandboxes.reduce(
    (sum, row) => sum + row.currentRateMillicreditsPerHour,
    0,
  );
}

/**
 * The poll for the balance and the cost view: every minute while any sandbox
 * accrues credits, none otherwise. With the app focused on one screen and
 * nothing changing state, no event would ever refresh the two, and the
 * runway warning could cross both thresholds unseen. Paused while the app is
 * in the background (`refetchIntervalInBackground: false` at each use); focus
 * refetches on return.
 *
 * `failed`: the cost read is in error while the control plane is available.
 * It then polls every minute too, so one failed read is retried instead of
 * leaving "Couldn't load the cost" up, and the balance unpolled, until a
 * focus event.
 */
export function sandboxCostsRefetchInterval(
  costs: UserSandboxCost | null,
  failed: boolean,
): number | false {
  if (failed) return SANDBOX_COST_REFRESH_MS;
  return costs !== null && accruingMillicreditsPerHour(costs) > 0
    ? SANDBOX_COST_REFRESH_MS
    : false;
}

interface CostReadSlot {
  readonly userId: string | null;
  pending: Promise<UserSandboxCost> | null;
  failure: { readonly error: Error; readonly retryAt: number } | null;
}

// The binding identifies the server. Slots belong only to the current sign-in.
let costReads = new WeakMap<AuthService, CostReadSlot>();
useAuthStore.subscribe((next, previous) => {
  if (
    next.status !== previous.status ||
    next.contextMetadata?.userId !== previous.contextMetadata?.userId
  ) {
    costReads = new WeakMap();
  }
});

function costReadSlot(
  auth: AuthService,
  userId: string | null,
): CostReadSlot | undefined {
  const slot = costReads.get(auth);
  return slot?.userId === userId ? slot : undefined;
}

function readSandboxCosts(
  auth: AuthService,
  userId: string | null,
): Promise<UserSandboxCost> {
  const session = useAuthStore.getState();
  if (
    session.status !== "signed-in" ||
    (session.contextMetadata?.userId ?? null) !== userId
  ) {
    return Promise.reject(new SupersededAuthEraError());
  }

  const slot = costReadSlot(auth, userId) ?? {
    userId,
    pending: null,
    failure: null,
  };
  if (slot.pending !== null) return slot.pending;
  if (slot.failure !== null && Date.now() < slot.failure.retryAt) {
    return Promise.reject(slot.failure.error);
  }

  const pending = auth
    .getSandboxCosts()
    .then((result) => {
      if (costReads.get(auth) !== slot) throw new SupersededAuthEraError();
      // An error must never read as zero burn and hide a runway warning.
      if (result.kind !== "ok") throw new Error(sandboxFailureMessage(result));
      slot.failure = null;
      return result.costs;
    })
    .catch((cause: unknown) => {
      const error =
        cause instanceof Error
          ? cause
          : new Error("Sandbox cost read failed", { cause });
      if (costReads.get(auth) === slot) {
        slot.failure = { error, retryAt: Date.now() + SANDBOX_COST_REFRESH_MS };
      }
      throw error;
    })
    .finally(() => {
      slot.pending = null;
    });
  slot.pending = pending;
  costReads.set(auth, slot);
  return pending;
}

function sandboxCostsQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<UserSandboxCost | null>({
      queryKey: sandboxQueryKeys.costsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<UserSandboxCost | null>({
    queryKey: sandboxQueryKeys.costs(auth, userId),
    queryFn: () => readSandboxCosts(auth, userId),
    enabled,
    retry: false,
    retryOnMount: false,
    // On focus, on the events `useRefreshSandboxCosts` invalidates on, and
    // every minute while its own answer says a sandbox accrues (the balance
    // it is divided into polls on the same rule there).
    refetchOnWindowFocus: true,
    // A disabled query (no control plane) never polls, so an error here is
    // always one with the control plane available.
    refetchInterval: (query) => {
      if (query.state.fetchStatus !== "idle") return false;
      const failure = costReadSlot(auth, userId)?.failure ?? null;
      // Repeated triggers during cooldown must leave the same wake time.
      if (failure !== null) {
        return Math.max(1, failure.retryAt - Date.now());
      }
      return sandboxCostsRefetchInterval(
        query.state.data ?? null,
        query.state.status === "error",
      );
    },
    refetchIntervalInBackground: false,
  });
}

/**
 * `GET /api/sandboxes/cost`: every listed sandbox's cost from the control
 * plane's ledger, and the user's awake burn (`awakeBurnMillicreditsPerHour`),
 * which the balance warnings divide the live balance by.
 *
 * Mount `useRefreshSandboxCosts` beside it on a surface that shows it, so the
 * figures move when a sandbox changes state or a Traycer turn spends credits.
 */
export function useSandboxCosts(): UseQueryResult<UserSandboxCost | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const unavailable = useSandboxControlUnavailableReason() !== null;
  return useQuery(
    sandboxCostsQueryOptions(auth, userId, signedIn && !unavailable),
  );
}
