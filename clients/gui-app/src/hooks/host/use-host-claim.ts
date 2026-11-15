import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { HostDoorState } from "@traycer-clients/shared/host-transport/host-door-state";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostBinding, useOptionalHostClient } from "@/lib/host";
import type { HostClaimFacts } from "@/lib/host/window-narration";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const NO_ENVIRONMENT_IDS: readonly string[] = [];

/**
 * A serial per stored door state: a state raised again is a new object, so
 * it reads the claims again; the same state read twice keeps its answer.
 */
const doorStateSerials = new WeakMap<HostDoorState, number>();
let nextDoorStateSerial = 0;

function doorStateSerial(state: HostDoorState): number {
  const known = doorStateSerials.get(state);
  if (known !== undefined) return known;
  nextDoorStateSerial += 1;
  doorStateSerials.set(state, nextDoorStateSerial);
  return nextDoorStateSerial;
}

/**
 * Who claimed `hostId` and from which team, while its door answers
 * `host_claimed`, or `null` until a claim for it is read. The claims of each
 * team the person belongs to are read once per state, through
 * `AuthService.listClaimedComputers`, and the claim naming this computer
 * gives the claimant; the team's name is that team's. Cancelled with the
 * state.
 */
export function useHostClaim(
  hostId: string | null,
  doorState: HostDoorState | null,
): HostClaimFacts | null {
  const claimed =
    hostId !== null &&
    doorState !== null &&
    doorState.kind === "host-claimed" &&
    doorState.hostId === hostId;
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  // The null-tolerant read: the window's narration mounts at the app root,
  // where a tree with no host runtime is a legitimate answer.
  const environments = useEnvironmentListQuery(
    useOptionalHostClient(),
    claimed,
  );
  const teams = useMemo(
    () =>
      (environments.data?.environments ?? []).filter(
        (environment) => environment.ownerKind === "organization",
      ),
    [environments.data],
  );
  const environmentIds = useMemo(
    () =>
      teams.length === 0
        ? NO_ENVIRONMENT_IDS
        : teams.map((team) => team.environmentId),
    [teams],
  );
  const read = useQuery(
    queryOptions({
      queryKey: authQueryKeys.hostClaim(auth, userId, {
        hostId: hostId ?? "",
        stateSerial: claimed ? doorStateSerial(doorState) : 0,
        environmentIds,
      }),
      enabled: claimed && auth !== null && userId !== null && teams.length > 0,
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      queryFn: async ({ signal }): Promise<HostClaimFacts | null> => {
        if (auth === null || hostId === null) return null;
        const answers = await Promise.all(
          teams.map(async (team) => ({
            team,
            result: await auth.listClaimedComputers(team.environmentId, signal),
          })),
        );
        for (const { team, result } of answers) {
          if (result.kind !== "ok") continue;
          const claim = result.claims.find((entry) => entry.hostId === hostId);
          if (claim !== undefined)
            return { claimantName: claim.claimantName, teamName: team.label };
        }
        return null;
      },
    }),
  );
  return claimed ? (read.data ?? null) : null;
}
