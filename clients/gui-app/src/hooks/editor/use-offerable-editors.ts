import { useMemo } from "react";
import { EDITORS, type EditorEntry } from "@traycer/protocol/host";
import { useEditorOpenPathsSupportsV11 } from "@/hooks/editor/use-editor-open-paths-version";

/** Editor ids outside the frozen 1.0 enum; a 1.0 host rejects them at parse. */
const POST_V10_EDITOR_IDS: ReadonlySet<string> = new Set(["vscodium"]);

/**
 * The editors a menu may OFFER for `hostId` - `EDITORS` narrowed to the ids
 * that host's negotiated minor can carry.
 *
 * Distinct from `useEditorAvailability`, which answers whether an editor is
 * INSTALLED on this machine. A menu needs both, and neither implies the other.
 *
 * Offering is the enforcement point: an id absent from every menu is never
 * emitted, and a stored default that falls out of this catalog is handled by
 * `resolveEditorState` / `resolveEffectiveDefaultEditor`.
 */
export function useOfferableEditors(
  hostId: string | null,
): ReadonlyArray<EditorEntry> {
  const supportsV11 = useEditorOpenPathsSupportsV11(hostId);
  return useMemo(
    () =>
      supportsV11
        ? EDITORS
        : EDITORS.filter((editor) => !POST_V10_EDITOR_IDS.has(editor.id)),
    [supportsV11],
  );
}
