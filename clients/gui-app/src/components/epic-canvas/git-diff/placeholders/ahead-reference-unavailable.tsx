import { GitCommitHorizontal } from "lucide-react";

interface AheadReferenceUnavailableProps {
  readonly filePath: string;
}

/**
 * Shown when a submodule "committed changes not recorded by parent" diff can no
 * longer be produced from *current* metadata - the parent reference moved, the
 * submodule is no longer ahead, or the host degraded to a parent-only view. It
 * is NOT a working-tree "no longer changed" state (that copy would misdescribe a
 * committed change), so it gets its own message.
 */
export function AheadReferenceUnavailable(
  props: AheadReferenceUnavailableProps,
) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      <GitCommitHorizontal className="size-12 text-muted-foreground" />
      <h3 className="text-base font-semibold">No longer listed</h3>
      <p className="text-sm text-muted-foreground">
        {props.filePath} is no longer listed as a committed submodule change for
        the current parent reference.
      </p>
    </div>
  );
}
