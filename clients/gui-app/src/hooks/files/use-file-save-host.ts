import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Native save capability, or `null` to fall back to browser save APIs. Missing provider must not throw: leaf surfaces also mount in host-less trees.
 */
export function useFileSaveHost(): IFileSaveHost | null {
  return useRunnerHostOrNull()?.fileSave ?? null;
}
