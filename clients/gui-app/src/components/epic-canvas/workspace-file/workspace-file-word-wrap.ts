import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The file viewer's effective line wrapping.
 *
 * `stored` is the user's explicit choice, or `null` when they have never made
 * one. With no choice, a coarse pointer wraps and a fine pointer does not.
 *
 * The asymmetry is about what unwrapped code costs each input device.
 * Unwrapped, the renderer puts a horizontal scroll box inside the viewer's
 * vertical one, and a touch drag feeds both at once - so reading down a file
 * drifts sideways. A fine pointer drives those two axes separately (a wheel,
 * a scrollbar, a caret) and gets long lines kept intact in exchange.
 *
 * The resolution deliberately lives here rather than in the persisted default:
 * a stored boolean would carry the device it was chosen on to every other one.
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
