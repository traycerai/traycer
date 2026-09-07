import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

export type StartTerminalLoginMutationResult<Captured> = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
  { readonly hostId: string | null; readonly captured: Captured }
>;

/** Client-scoped only; no app-wide wrapper. Invalidate terminal.list. Open the tile from mutation-level onSuccess. */
export function useProvidersStartTerminalLoginForClient<Captured>(
  client: HostClient<HostRpcRegistry> | null,
  onSuccess: (
    data: ResponseOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
    variables: RequestOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
    /** The host the request was SENT on, captured in `onMutate`. */
    hostId: string | null,
    /** Whatever `captureContext` read at send time. */
    captured: Captured,
  ) => void,
  /** Per-press state for `onSuccess`, read once per request in press order. */
  captureContext:
    | ((
        variables: RequestOfMethod<
          HostRpcRegistry,
          "providers.startTerminalLogin"
        >,
      ) => Captured)
    | undefined,
): StartTerminalLoginMutationResult<Captured> {
  return useHostScopedMutationForClient(client, {
    method: "providers.startTerminalLogin",
    mutationKey: providersMutationKeys.startTerminalLogin(),
    errorMessage: "Couldn't open a sign-in terminal.",
    invalidateMethods: ["terminal.list"],
    onSuccess,
    captureContext,
  });
}
