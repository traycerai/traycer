import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  SandboxCreateAccepted,
  SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { authQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useAuthStore } from "@/stores/auth/auth-store";

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
  // The account the sandbox list and costs are keyed by.
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useMutation({
    mutationKey: sandboxMutationKeys.create(userId),
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
    // At hook level, not the form's `mutate` call: the form unmounts when the
    // dialog closes, and a create can take minutes, so only the mutation
    // itself is still there to say it finished.
    onSuccess: (_data, request) => {
      toast.success(`Created ${request.displayName}`);
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
