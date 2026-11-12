import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  EnvironmentBindingReadRequest,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  hostStatusAnswer,
  readsHostBindingsFromPool,
  type HostStatusAnswer,
} from "@/hooks/bots/use-host-environment-bindings-query";

const EMPTY_PARAMS = {};

/**
 * Where a host is placed, as the binding read answers it:
 *
 * - `own_settings`: its own `environment.status` says it runs its own
 *   settings (the picker's Local row). It is in no environment, so there is
 *   no binding to read: never Personal, and never a failure.
 * - `pending`: its status has not answered yet.
 * - `binding`: anything else, with the binding read itself. A host whose
 *   status failed, or that predates the method, lands here, as before.
 */
export type EnvironmentHostRead =
  | { readonly kind: "own_settings" }
  | { readonly kind: "pending" }
  | {
      readonly kind: "binding";
      readonly query: UseQueryResult<EnvironmentHostBinding, HostRpcError>;
    };

/**
 * The one environment `hostId`, the host behind `client`, is bound to, for
 * the signed-in user. `explicit: false` means the owner never bound it and it
 * sits in their personal environment - the only default there is.
 *
 * Per host by construction: a binding is a fact about one machine, so the
 * caller names the host (the scoped Settings client and its host id) and this
 * hook never reaches for the app-wide one on its own. In a build with a pool
 * the answer is the pool's (`environment.binding.read { hostId }`, keyed by
 * the viewer, as `useEnvironmentListQuery` explains); without one it is the
 * host's own (`environment.host.read`). Either way it lands in the entry
 * `useHostEnvironmentBindings` reads for the same host, and a bind writes
 * through to it. Both reads are declared because hooks cannot be called
 * conditionally; the build's arm is the only one ever enabled.
 *
 * The host's own `environment.status` comes first (`EnvironmentHostRead`):
 * the pool answers a host that runs its own settings as Personal, and the
 * host refuses to answer at all. Without a pool the host is asked for its
 * binding only after its status has said it is in an environment; with one,
 * the pool's answer waits for that status. With no client there is no
 * status to wait for.
 */
export function useEnvironmentHostReadQuery(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentHostRead {
  const fromPool = readsHostBindingsFromPool();
  const statusAnswer = useHostStatusAnswer(client, hostId, enabled);
  const poolClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  const viewerUserId = useCloudChatViewerId();
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // `hostId` is null only while the scope has no host, when neither read is
  // enabled; the empty id is never sent.
  const poolParams = useMemo<EnvironmentBindingReadRequest>(
    () => ({ hostId: hostId ?? "" }),
    [hostId],
  );
  const pooled = useHostQuery<HostRpcRegistry, "environment.binding.read">({
    cacheKeyIdentity: [viewerUserId],
    client: poolClient,
    method: "environment.binding.read",
    params: poolParams,
    preflight: cloudVerdictPreflight("environment.binding.read"),
    options: {
      enabled:
        fromPool &&
        enabled &&
        cloudAuthorized &&
        hostId !== null &&
        viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    },
  });
  const own = useHostQuery<HostRpcRegistry, "environment.host.read">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.host.read",
    params: EMPTY_PARAMS,
    options: {
      enabled: !fromPool && enabled && statusAnswer === "other",
      refetchOnWindowFocus: false,
    },
  });
  if (statusAnswer === "own_settings") return { kind: "own_settings" };
  if (enabled && statusAnswer === "unsettled") return { kind: "pending" };
  return { kind: "binding", query: fromPool ? pooled : own };
}

/**
 * The host's own `environment.status`, as it bears on its binding. With no
 * client, or on a host without the method, there is nothing to wait for.
 */
function useHostStatusAnswer(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): HostStatusAnswer {
  const supported = useHostMethodSupport(hostId, "environment.status");
  const status = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: EMPTY_PARAMS,
    options: {
      enabled: enabled && supported === true,
      refetchOnWindowFocus: false,
    },
  });
  return hostStatusAnswer(status, client !== null && supported !== false);
}
