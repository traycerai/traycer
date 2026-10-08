import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  SandboxCreateAccepted,
  SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { authQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";

interface SandboxCreateContext {
  readonly directory: HostDirectoryService | null;
}

/**
 * `POST /api/sandboxes` from the create form. The server answers `202` once
 * the sandbox is created and its host is enrolling (the request can take
 * minutes: provider capacity, boot, boot-token delivery); the sandbox then
 * appears in the host list and the sandbox list, so the end of the request
 * refreshes both (one prefix covers both, see `sandboxQueryKeys.list`) and
 * the directory.
 */
export function useSandboxCreate(): UseMutationResult<
  SandboxCreateAccepted,
  Error,
  SandboxCreateRequest,
  SandboxCreateContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: sandboxMutationKeys.create(),
    onMutate: (): SandboxCreateContext => ({
      directory: binding === null ? null : binding.directory,
    }),
    mutationFn: async (request): Promise<SandboxCreateAccepted> => {
      if (binding === null) {
        throw new Error("Sign in to create a sandbox.");
      }
      const result = await binding.auth.createSandbox(request);
      if (result.kind === "ok") {
        return result.accepted;
      }
      throw new Error(sandboxFailureMessage(result));
    },
    // Settled, not only success: a `502 provider_failed` leaves a `failed`
    // row behind, which the lists must show so it can be destroyed.
    onSettled: (_data, _error, _variables, context) => {
      void context?.directory?.refresh();
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
    },
    onError: (error) =>
      toastFromAuthError(error, "Couldn't create the sandbox."),
  });
}
