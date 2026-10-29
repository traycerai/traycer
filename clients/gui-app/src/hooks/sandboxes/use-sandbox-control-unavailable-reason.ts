import { SANDBOXES_NOT_IN_THIS_BUILD } from "@/lib/sandboxes/sandbox-strings";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * Why this build cannot reach the sandbox control plane at all, or `null`
 * (`IRunnerHost.sandboxControlUnavailableReason`: a staging mobile build). The
 * sandbox queries do not run while it is set, and the sandbox surfaces show
 * it in place of their controls; `AuthService` refuses every call beneath
 * them as well.
 */
export function useSandboxControlUnavailableReason(): string | null {
  const reason = useRunnerHostOrNull()?.sandboxControlUnavailableReason ?? null;
  // A build without sandboxes (`unreleased-features.ts`) reaches no control
  // plane either: the costs, catalogue and list reads beneath this stay off.
  return UNRELEASED_FEATURES_ENABLED
    ? reason
    : (reason ?? SANDBOXES_NOT_IN_THIS_BUILD);
}
