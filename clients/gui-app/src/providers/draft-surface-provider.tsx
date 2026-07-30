import { useEffect, type ReactNode } from "react";
import { DraftSurfaceContext } from "@/providers/draft-surface-context";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";

/**
 * Keyed per-draft mount point. T6 adds the draft runtime registry beneath this
 * boundary without changing the top-level host's retention identity.
 */
export function DraftSurfaceProvider(props: {
  readonly draftId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  useEffect(() => {
    draftRuntimeRegistry.attach(props.draftId);
    return () => {
      // Surface eviction is not draft close. The exact pending writer flushes,
      // while the keyed runtime keeps submission and attachment roots alive.
      draftRuntimeRegistry.detach(props.draftId);
    };
  }, [props.draftId]);

  return (
    <DraftSurfaceContext.Provider value={props.draftId}>
      {props.children}
    </DraftSurfaceContext.Provider>
  );
}
