import { type ReactNode } from "react";
import { DraftSurfaceContext } from "@/providers/draft-surface-context";

/**
 * Keyed per-draft mount point. T6 adds the draft runtime registry beneath this
 * boundary without changing the top-level host's retention identity.
 */
export function DraftSurfaceProvider(props: {
  readonly draftId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <DraftSurfaceContext.Provider value={props.draftId}>
      {props.children}
    </DraftSurfaceContext.Provider>
  );
}
