import { useMemo } from "react";
import { EDITORS, type EditorEntry } from "@traycer/protocol/host";
import { useEditorOpenPathsSupportsV11 } from "@/hooks/editor/use-editor-open-paths-version";

/** Editor ids outside the frozen 1.0 enum; a 1.0 host rejects them at parse. */
const POST_V10_EDITOR_IDS: ReadonlySet<string> = new Set(["vscodium"]);

/**
 * Ids this host's negotiated minor can carry. Distinct from installed-on-this-machine (`useEditorAvailability`); neither implies the other.
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
