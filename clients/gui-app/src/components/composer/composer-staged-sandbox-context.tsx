import type { ReactNode } from "react";
import { ComposerStagedSurfaceKeyContext } from "@/components/composer/composer-staged-surface-key";

/**
 * Names the key a sandbox may be staged under for everything this composer
 * renders, its pickers included, so a sentence about where the run goes
 * names the staged sandbox rather than the placement host.
 */
export function ComposerStagedSurfaceKeyProvider(props: {
  readonly surfaceKey: string | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ComposerStagedSurfaceKeyContext.Provider value={props.surfaceKey}>
      {props.children}
    </ComposerStagedSurfaceKeyContext.Provider>
  );
}
