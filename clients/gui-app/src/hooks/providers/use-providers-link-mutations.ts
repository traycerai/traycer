import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { providersMutationKeys } from "@/lib/query-keys";

type LinkMethod =
  | "providers.link"
  | "providers.linkComplete"
  | "providers.linkCancel";

interface LinkVariables<Method extends LinkMethod> {
  readonly client: HostClient<HostRpcRegistry>;
  readonly request: RequestOfMethod<HostRpcRegistry, Method>;
}

type LinkMutationResult<Method extends LinkMethod> = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  LinkVariables<Method>
>;

// Each dispatch carries the attempt's captured client. Errors belong to the
// inline sign-in surface; completion is certified by its fresh inventory read.
export function useProvidersLink(): LinkMutationResult<"providers.link"> {
  return useHostMutation<
    HostRpcRegistry,
    "providers.link",
    unknown,
    LinkVariables<"providers.link">
  >({
    client: (variables) => variables.client,
    method: "providers.link",
    mapVariables: (variables) => variables.request,
    requiredHostMethodVersion: () => ({
      method: "providers.link",
      version: { major: 1, minor: 2 },
    }),
    options: {
      mutationKey: providersMutationKeys.link(),
      retry: false,
      gcTime: 0,
    },
  });
}

export function useProvidersLinkComplete(): LinkMutationResult<"providers.linkComplete"> {
  return useHostMutation<
    HostRpcRegistry,
    "providers.linkComplete",
    unknown,
    LinkVariables<"providers.linkComplete">
  >({
    client: (variables) => variables.client,
    method: "providers.linkComplete",
    mapVariables: (variables) => variables.request,
    requiredHostMethodVersion: () => ({
      method: "providers.linkComplete",
      version: { major: 1, minor: 2 },
    }),
    options: {
      mutationKey: providersMutationKeys.linkComplete(),
      retry: false,
      gcTime: 0,
    },
  });
}

export function useProvidersLinkCancel(): LinkMutationResult<"providers.linkCancel"> {
  return useHostMutation<
    HostRpcRegistry,
    "providers.linkCancel",
    unknown,
    LinkVariables<"providers.linkCancel">
  >({
    client: (variables) => variables.client,
    method: "providers.linkCancel",
    mapVariables: (variables) => variables.request,
    options: {
      mutationKey: providersMutationKeys.linkCancel(),
      retry: false,
      gcTime: 0,
    },
  });
}
