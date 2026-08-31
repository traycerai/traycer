import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Whether this shell can put an IMAGE on the system clipboard, for the
 * surfaces that offer a "Copy image" control.
 *
 * Defaults to `true` with no provider mounted, and deliberately so: a tree
 * without a runner host is a browser tab or a test harness, both of which
 * honour the write. The shell that answers `false` is the one that has to say
 * so, because its failure mode is a write that RESOLVES having done nothing -
 * so absence of a host must not be read as absence of the capability, or every
 * host-less surface would silently lose its Copy button.
 *
 * Tolerant of a missing provider for the same reason as `useFileSaveHost`:
 * copy affordances hang off leaf surfaces that also mount in host-less trees,
 * and a capability that degrades must not crash the tree around it.
 */
export function useCanCopyImages(): boolean {
  return useRunnerHostOrNull()?.canCopyImages ?? true;
}
