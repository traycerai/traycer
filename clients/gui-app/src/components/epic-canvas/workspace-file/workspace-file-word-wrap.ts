import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * `stored` is the user's explicit choice, or `null` when they have never made one.
 * The resolution deliberately lives here rather than in the persisted default: a stored boolean would carry the device it was chosen on to every other one.
 */
export function resolveWorkspaceFileWordWrap(
  stored: boolean | null,
  coarsePointer: boolean,
): boolean {
  return stored ?? coarsePointer;
}

export interface WorkspaceFileWordWrapControl {
  readonly wordWrap: boolean;
  /** Records an explicit choice; the device default is no longer consulted. */
  readonly setWordWrap: (value: boolean) => void;
}

export function useWorkspaceFileWordWrap(): WorkspaceFileWordWrapControl {
  const stored = useSettingsStore((state) => state.workspaceFileWordWrap);
  const setWordWrap = useSettingsStore(
    (state) => state.setWorkspaceFileWordWrap,
  );
  const coarsePointer = useCoarsePointer();
  return {
    wordWrap: resolveWorkspaceFileWordWrap(stored, coarsePointer),
    setWordWrap,
  };
}
