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

type StartTerminalLoginMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
  { readonly hostId: string | null }
>;

/**
 * Asks the host to open (or re-open) a sign-in terminal for a provider whose
 * login cannot run headlessly.
 *
 * Client-scoped only: the terminal is created on, and lives on, a specific
 * host, and the banner that calls this is bound to its tab's host for life.
 * There is deliberately no app-wide-default variant - the app-wide host is
 * never the right answer here.
 *
 * `invalidateMethods` carries `terminal.list` because the host created this
 * PTY outside the renderer's own `terminal.create`: nothing else invalidates
 * that query, it never polls, and it shares a 60 s `staleTime`, so without
 * this the epic's Terminals sidebar stays blind to the session for a minute.
 * Same reason `useSetupTerminalListRefreshDriver` exists for setup terminals.
 *
 * `onSuccess` is required and lands at the MUTATION level, not per-`mutate`:
 * this call makes the host create a PTY, so a caller that unmounts before the
 * response (a canvas tab switch, a host-binding blip) must still get its tile
 * opened. Per-`mutate` callbacks are dropped in exactly that case, which would
 * leave a live sign-in terminal the user can only reach by hunting through the
 * Terminals sidebar.
 */
export function useProvidersStartTerminalLoginForClient(
  client: HostClient<HostRpcRegistry> | null,
  onSuccess: (
    data: ResponseOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
    variables: RequestOfMethod<HostRpcRegistry, "providers.startTerminalLogin">,
  ) => void,
): StartTerminalLoginMutationResult {
  return useHostScopedMutationForClient(client, {
    method: "providers.startTerminalLogin",
    mutationKey: providersMutationKeys.startTerminalLogin(),
    errorMessage: "Couldn't open a sign-in terminal.",
    invalidateMethods: ["terminal.list"],
    onSuccess,
  });
}
