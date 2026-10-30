import { useCallback, useState } from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderId,
  ProviderManagedInstallErrorReason,
  ProviderManagedInstallState,
  ProviderPackVersionInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { providerPackErrorDetail } from "@/components/providers/provider-pack-readiness";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersEnsurePackForClient } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersRefreshPackDiscoveryForClient } from "@/hooks/providers/use-providers-refresh-pack-discovery-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { hostQueryKeys } from "@/lib/query-keys";

export interface ProviderUpdate {
  /** Updates the harness's provider on the host; `null` where the host cannot. */
  readonly update: ((harnessId: string) => void) | null;
  /** `true` from the press until the host's install of the update settles. */
  readonly pending: boolean;
  /** Why the last update did not take, for the row to say; `null` otherwise. */
  readonly failure: string | null;
}

/**
 * Where the last press stands: its requests in flight; the host's install of
 * the version it said it was installing (`target`, `null` where it could not
 * name one), judged on list reads from `since`, a moment before the request
 * left, against the version installed before the press (`before`); or failed.
 */
type UpdatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting" }
  | {
      readonly kind: "installing";
      readonly providerId: ProviderId;
      readonly since: number;
      readonly target: string | null;
      readonly before: string | null;
    }
  | { readonly kind: "failed"; readonly message: string };

type ProvidersList = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type ProviderRow = ProvidersList["providers"][number];

const NOTHING_NEWER = "There's no newer version to install yet.";
const DID_NOT_FINISH = "The update did not finish.";

/**
 * Update for a provider whose command-line tool its service refused as out of
 * date (Tracy Bots T71), on `hostId` through `client`: the host checks for the
 * provider's newest version (`providers.refreshPackDiscovery`), then moves its
 * managed copy to it (`providers.ensurePack`, the gesture Settings' retry
 * makes); the next run uses it. The host decided the update can help before
 * the row offered it, so this only asks whether the host has the method.
 * Pressed by a person only: `ensurePack` marks the request user-initiated.
 *
 * The check names the provider's pack, which only `providers.list` carries:
 * read from its cache, or fetched through `client` when none is cached. The
 * host only starts the install, so after it takes the request this watches
 * the host's list (which polls fast while bytes move) and stays pending until
 * the provider's install settles. It settles as done only once the version
 * the host set out to install is the one installed: a replacement that fails
 * leaves the old copy runnable, which the list reports as installed. Anything
 * else is said as a failure, with the host's reason where it gave one.
 */
export function useProviderUpdateForClient(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): ProviderUpdate {
  const queryClient = useQueryClient();
  const canEnsure =
    useHostSupportsMethod(hostId, "providers.ensurePack") && client !== null;
  const canRefresh = useHostSupportsMethod(
    hostId,
    "providers.refreshPackDiscovery",
  );
  const refresh = useProvidersRefreshPackDiscoveryForClient(client, null);
  const ensure = useProvidersEnsurePackForClient(client);
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const watching = phase.kind === "installing";
  const listed = useProvidersListForClient(client, {
    enabled: watching,
    subscribed: watching,
  });
  const update = useCallback(
    (harnessId: string) => {
      const harness = guiHarnessIdSchema.safeParse(harnessId);
      if (!harness.success || client === null) return;
      const providerId = providerCliIdForHarness(harness.data);
      if (providerId === null) return;
      setPhase({ kind: "requesting" });
      // Filed under the host that answers it, as `useHostQuery` files it.
      const listHostId = client.getActiveHostId();
      const readList = (staleTime: number): Promise<ProvidersList | null> =>
        listHostId === null
          ? Promise.resolve(null)
          : queryClient
              .fetchQuery(
                queryOptions({
                  queryKey: hostQueryKeys.method<
                    HostRpcRegistry,
                    "providers.list"
                  >(listHostId, "providers.list", { native: null }),
                  queryFn: () =>
                    client.request("providers.list", { native: null }),
                  staleTime,
                  retry: false,
                }),
              )
              .catch(() => null);
      void (async () => {
        // A cached list names the pack and the installed version as well as
        // a fresh one.
        const row =
          (await readList(Number.POSITIVE_INFINITY))?.providers.find(
            (candidate) => candidate.providerId === providerId,
          ) ?? null;
        const packId = canRefresh ? (row?.packId ?? null) : null;
        // A refused or failed check is toasted by its hook; the update still
        // runs, on whatever the host already knows.
        if (packId !== null) {
          await refresh.mutateAsync({ packId }).catch(() => undefined);
        }
        // Before the request leaves: the list read its success invalidates
        // can finish before the answer reaches this line.
        const since = Date.now();
        const started = await ensure.mutateAsync({ providerId }).then(
          (response) => response.managedInstallState,
          (error: Error) => {
            setPhase({ kind: "failed", message: error.message });
            return undefined;
          },
        );
        if (started === undefined) return;
        if (started?.status === "error") {
          setPhase({ kind: "failed", message: failedWith(started.reason) });
          return;
        }
        if (started?.status !== "downloading") {
          setPhase({ kind: "failed", message: NOTHING_NEWER });
          return;
        }
        setPhase({
          kind: "installing",
          providerId,
          since,
          target: started.version ?? null,
          before: installedVersion(row),
        });
        // One read the host answered after it took the request, whatever
        // else has read the list meanwhile.
        await readList(0);
      })();
    },
    [canRefresh, client, ensure, queryClient, refresh],
  );
  return {
    update: canEnsure ? update : null,
    ...presentPhase(phase, listed.data, listed.dataUpdatedAt),
  };
}

function presentPhase(
  phase: UpdatePhase,
  list: ProvidersList | undefined,
  listUpdatedAt: number,
): Omit<ProviderUpdate, "update"> {
  switch (phase.kind) {
    case "idle":
      return { pending: false, failure: null };
    case "requesting":
      return { pending: true, failure: null };
    case "failed":
      return { pending: false, failure: phase.message };
    case "installing":
      return presentInstall(phase, list, listUpdatedAt);
  }
}

function presentInstall(
  phase: Extract<UpdatePhase, { readonly kind: "installing" }>,
  list: ProvidersList | undefined,
  listUpdatedAt: number,
): Omit<ProviderUpdate, "update"> {
  // A list read before the request left says nothing about it.
  if (list === undefined || listUpdatedAt < phase.since) {
    return { pending: true, failure: null };
  }
  const row = list.providers.find(
    (candidate) => candidate.providerId === phase.providerId,
  );
  const slot = row?.managedInstallState ?? null;
  const target = targetInstallState(row, phase.target);
  if (slot?.status === "downloading" || target?.status === "downloading") {
    return { pending: true, failure: null };
  }
  if (slot?.status === "installed" && upgraded(phase, slot.version ?? null)) {
    return { pending: false, failure: null };
  }
  const reason = installFailureReason(target, slot);
  return {
    pending: false,
    failure: reason === null ? DID_NOT_FINISH : failedWith(reason),
  };
}

/** The version the host set out to install, as its own version row reports it. */
function targetInstallState(
  row: ProviderRow | undefined,
  target: string | null,
): ProviderPackVersionInstallState | null {
  if (target === null) return null;
  return (
    row?.managedVersions?.available.find(
      (version) => version.version === target,
    )?.installState ?? null
  );
}

/** Why the install failed, the target's own row first; `null` where neither says. */
function installFailureReason(
  target: ProviderPackVersionInstallState | null,
  slot: ProviderManagedInstallState | null,
): ProviderManagedInstallErrorReason | null {
  if (target?.status === "error") return target.reason;
  if (slot?.status === "error") return slot.reason;
  return null;
}

/**
 * Whether the installed copy is the update's: the version the host set out
 * to install, or, where it named none, not the one installed before the
 * press. A copy whose version the host cannot name is taken at its word.
 */
function upgraded(
  phase: Extract<UpdatePhase, { readonly kind: "installing" }>,
  installed: string | null,
): boolean {
  if (installed === null) return true;
  return phase.target === null
    ? installed !== phase.before
    : installed === phase.target;
}

function installedVersion(row: ProviderRow | null): string | null {
  const slot = row?.managedInstallState;
  return slot?.status === "installed" ? (slot.version ?? null) : null;
}

function failedWith(reason: ProviderManagedInstallErrorReason): string {
  return `The update failed: ${providerPackErrorDetail(reason)}`;
}
