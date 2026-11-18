import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * The shell's native save capability, for the surfaces that hand bytes to
 * {@link saveBlobToDisk}, or `null` where there is none to use.
 *
 * Deliberately tolerant of a missing provider rather than demanding one. Save
 * affordances hang off leaf surfaces - an image inside rendered markdown, a
 * Mermaid node view - which also mount in trees that carry no runner host at
 * all, and "no host" wants the same answer as "a host with no native save
 * route": fall back to the browser save APIs, which is exactly what `null`
 * selects downstream. Throwing here would turn a capability that degrades
 * into one that crashes the tree around it.
 */
export function useFileSaveHost(): IFileSaveHost | null {
  return useRunnerHostOrNull()?.fileSave ?? null;
}
