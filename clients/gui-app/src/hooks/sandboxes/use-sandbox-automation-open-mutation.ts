import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  SandboxAutomationOpenTarget,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { toast } from "sonner";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { authQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * What an open left: the row (created on a first open, so its host id is
 * known only now) and whether it is awake (`200`) or still moving (`202`).
 */
export interface SandboxAutomationOpened {
  readonly sandbox: SandboxSummary;
  readonly settled: boolean;
}

interface SandboxAutomationOpenContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the open started. */
  readonly userId: string | null;
}

/**
 * `POST /api/sandboxes/automation`: the Sandboxes page's Open terminal on an
 * Automations row that is not awake, Personal's (`null`) or a team pod (its
 * environment and ordinal). Creates the row on first use and wakes a released one; resolves to
 * the row, `settled` once it is awake (`200`) and not while it is still
 * creating or starting (`202`). Settled either way, the row has moved, so the Automations
 * read, the sandbox list and the host list (one prefix covers all three, see
 * `sandboxQueryKeys.automation`) and the directory are refreshed.
 */
export function useSandboxAutomationOpen(
  feedback: "toast" | "inline",
): UseMutationResult<
  SandboxAutomationOpened,
  Error,
  SandboxAutomationOpenTarget | null,
  SandboxAutomationOpenContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useMutation({
    mutationKey: sandboxMutationKeys.automationOpen(userId),
    onMutate: (): SandboxAutomationOpenContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async (
      target: SandboxAutomationOpenTarget | null,
    ): Promise<SandboxAutomationOpened> => {
      if (binding === null) {
        throw new Error("Sign in to start Automations.");
      }
      const result = await binding.auth.openSandboxAutomation(target);
      if (result.kind === "ok") {
        return { sandbox: result.sandbox, settled: result.settled };
      }
      throw new SandboxOperationError(result);
    },
    onSettled: (_data, _error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      void context.directory?.refresh();
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
    },
    // A team pod's open reports here, not at the call: the picker that
    // started it closes on run, and a call-site callback dies with it.
    onSuccess: (opened, target, context) => {
      if (
        feedback === "inline" ||
        target === null ||
        !settledForStartingAccount(context)
      )
        return;
      if (opened.settled) toast.success("The team pod is open");
      else toast.info("Opening the team pod…");
    },
    onError: (error, target, context) => {
      if (feedback === "inline" || !settledForStartingAccount(context)) return;
      toastFromAuthError(
        error,
        target === null
          ? "Couldn't start Automations. Retry it from Settings ▸ Sandboxes."
          : "Couldn't open this team pod.",
      );
    },
  });
}
