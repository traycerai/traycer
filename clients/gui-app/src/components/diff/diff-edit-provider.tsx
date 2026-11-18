import { EditProvider } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import { createPreloadedDiffEditor } from "@/components/diff/diff-edit-provider-loader";

/**
 * A stable context boundary for read and edit mode. The heavy editor module is
 * still loaded on pointer intent, but adding an editor no longer reparents and
 * remounts the already-painted Diffs component.
 */
export function DiffEditProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <EditProvider<undefined> createEditor={createPreloadedDiffEditor}>
      {props.children}
    </EditProvider>
  );
}
