import { createContext, use } from "react";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";

/** The key a composer's staged sandbox lives under, or `null` for none. */
export const ComposerStagedSurfaceKeyContext = createContext<string | null>(
  null,
);

/**
 * The name of the sandbox staged on the enclosing composer, which the next
 * run goes to; `null` when none is staged, or outside a staging composer.
 */
export function useComposerStagedSandboxName(): string | null {
  const surfaceKey = use(ComposerStagedSurfaceKeyContext);
  return useStagedSandboxStore((state) =>
    surfaceKey === null
      ? null
      : (state.bySurface[surfaceKey]?.target.name ?? null),
  );
}
