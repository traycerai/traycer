import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  HostRpcError,
  isTransientHostRpcFailure,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import type {
  SimulatorInstanceChoice,
  SimulatorPlatform,
} from "@traycer/protocol/host/simulator/schemas";
import { INSTANCE_INVALIDATIONS } from "@/hooks/simulator/use-simulator-mutations";
import { useHostBinding, useHostDirectory } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/simulator-open-response-timeout";
import { simulatorMutationKeys } from "@/lib/query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { requestSimulatorConnect } from "@/lib/simulator-view/simulator-connect-requests";
import { simulatorHostSpeaksV11 } from "@/lib/simulator-view/simulator-host-version";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";
import {
  addSimulatorPendingOpen,
  placeSimulatorPendingOpenTile,
  removeSimulatorPendingOpen,
  updateSimulatorPendingOpen,
} from "@/stores/epics/simulator-pending-opens-store";

/** The device or instance an open names, as the surface that lists it shows it. */
export interface SimulatorOpenTarget {
  readonly simulatorId: string;
  readonly platform: SimulatorPlatform;
  readonly name: string;
  readonly version: string;
}

export interface SimulatorInstanceOpenArgs {
  readonly hostId: string;
  readonly target: SimulatorOpenTarget;
  /** Watch is the instance's key, Boot `"auto"`, Boot another `"new"`. */
  readonly instance: SimulatorInstanceChoice;
  readonly place: (ref: SimulatorTileRef) => void;
}

interface OpenVariables {
  readonly hostId: string;
  readonly requestId: string;
  readonly target: SimulatorOpenTarget;
  readonly instance: SimulatorInstanceChoice;
}

/**
 * The person's Boot, Boot another and Watch, from every surface that lists
 * instances: the + picker, the palette and the mobile switcher.
 *
 * On a `@1.1` host the open is sent here, before any tile exists, with the
 * instance and a `requestId` the host names it by. The answer, or the
 * sessions stream's session carrying that `requestId`, places the tile (see
 * `SimulatorCatalogProvider`). An answer that never arrives is not a
 * failure: the stream says how it ended. A repeated click is its own open,
 * answered in its own right; the panel's pending row is keyed by what the
 * open NAMED, so the two share one (see `buildSimulatorListGroups`).
 *
 * A `@1.0` host ignores `instance`, so Boot another is refused there rather
 * than silently sharing the device, and Boot and Watch keep today's path:
 * the tile is placed and sends its own open.
 */
export function useSimulatorInstanceOpen(epicId: string): {
  readonly open: (args: SimulatorInstanceOpenArgs) => void;
} {
  const binding = useHostBinding();
  const directory = useHostDirectory();
  const queryClient = useQueryClient();
  const mutation = useMutation<null, Error, OpenVariables>({
    mutationKey: simulatorMutationKeys.instanceOpen(epicId),
    retry: false,
    mutationFn: async ({ hostId, requestId, target, instance }) => {
      const client = resolveNamedHostClient(binding, hostId);
      if (client === null) throw new Error("Couldn't reach this host.");
      try {
        const response = await client.requestWithOptions(
          "simulator.open",
          {
            epicId,
            simulatorId: target.simulatorId,
            platform: target.platform,
            boot: true,
            instance,
            requestId,
          },
          {
            idempotencyKey: null,
            responseTimeoutMs: SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS,
            requiredHostMethodVersion: {
              method: "simulator.open",
              version: { major: 1, minor: 1 },
            },
            signal: undefined,
          },
        );
        updateSimulatorPendingOpen(requestId, {
          sessionId: response.session.sessionId ?? null,
        });
        placeSimulatorPendingOpenTile(
          requestId,
          makeSimulatorTileRef({
            hostId,
            simulatorId: response.simulator.simulatorId,
            platform: response.simulator.platform,
            name: response.simulator.name,
          }),
        );
        return null;
      } catch (error) {
        if (error instanceof HostRpcError && isTransientHostRpcFailure(error)) {
          updateSimulatorPendingOpen(requestId, { answerLost: true });
          return null;
        }
        removeSimulatorPendingOpen(requestId);
        throw error;
      }
    },
    onSettled: (_data, _error, variables) => {
      for (const method of INSTANCE_INVALIDATIONS) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(variables.hostId, method),
        });
      }
    },
    onError: (error) => {
      if (error instanceof HostRpcError)
        toastFromHostError(error, "Couldn't open the simulator.");
      else toast.error("Couldn't open the simulator.");
    },
  });
  const { mutate } = mutation;
  const open = useCallback(
    (args: SimulatorInstanceOpenArgs) => {
      const { hostId, target, instance, place } = args;
      const entry = directory.findById(hostId);
      const directoryLabel = entry?.label.trim() ?? "";
      const label = directoryLabel.length > 0 ? directoryLabel : "This host";
      if (
        entry === null ||
        (hostUnavailability(entry) === "offline" &&
          !hasReadyRemoteSession(hostId))
      ) {
        toast.error(`${label} is unreachable right now.`);
        return;
      }
      const speaks = simulatorHostSpeaksV11(hostId);
      if (speaks !== true) {
        if (instance === "new") {
          toast.error(
            speaks === null
              ? `Couldn't reach ${label} yet. Try again.`
              : `${label} needs an update before it can boot another copy.`,
          );
          return;
        }
        const ref = makeSimulatorTileRef({
          hostId,
          simulatorId: target.simulatorId,
          platform: target.platform,
          name: target.name,
        });
        requestSimulatorConnect(ref.id);
        place(ref);
        return;
      }
      const requestId = crypto.randomUUID();
      addSimulatorPendingOpen(
        {
          requestId,
          epicId,
          hostId,
          simulatorId: target.simulatorId,
          instanceKey:
            instance === "auto" || instance === "new" ? null : instance,
          name: target.name,
          platform: target.platform,
          version: target.version,
          sessionId: null,
          seenOpening: false,
          answerLost: false,
          placed: false,
        },
        place,
      );
      mutate({ hostId, requestId, target, instance });
    },
    [directory, epicId, mutate],
  );
  return { open };
}
