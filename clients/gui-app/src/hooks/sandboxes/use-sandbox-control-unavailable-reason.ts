import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Why this build cannot reach the sandbox control plane at all, or `null`
 * (`IRunnerHost.sandboxControlUnavailableReason`: a staging build). The
 * sandbox queries do not run while it is set, and the sandbox surfaces show
 * it in place of their controls; `AuthService` refuses every call beneath
 * them as well.
 */
export function useSandboxControlUnavailableReason(): string | null {
  return useRunnerHostOrNull()?.sandboxControlUnavailableReason ?? null;
}
