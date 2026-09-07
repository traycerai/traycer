import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Defaults to `true` with no provider: a missing host is not a missing capability. The shell that cannot write must say so; a no-op write would otherwise hide the Copy button.
 */
export function useCanCopyImages(): boolean {
  return useRunnerHostOrNull()?.canCopyImages ?? true;
}
