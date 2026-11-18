import { useMemo } from "react";
import {
  EDITORS,
  type EditorEntry,
  type EditorId,
} from "@traycer/protocol/host";
import { useEditorOpenPathsVersion } from "@/hooks/editor/use-editor-open-paths-version";

/**
 * The `editor.openPaths` minor that first accepts each editor id. Keyed by id,
 * so an editor added to `EDITORS` without a floor fails to compile. 1.0 carries
 * the original four; a 1.0 - 1.2 host rejects a later id at parse.
 */
const EDITOR_MINIMUM_MINOR: Readonly<Record<EditorId, number>> = {
  vscode: 0,
  cursor: 0,
  windsurf: 0,
  zed: 0,
  vscodium: 1,
  "code-oss": 3,
};

/**
 * The editors a menu may OFFER for `hostId` - `EDITORS` narrowed to the ids
 * that host's negotiated minor can carry.
 *
 * Distinct from `useEditorAvailability`, which answers whether an editor is
 * INSTALLED on this machine. A menu needs both, and neither implies the other.
 *
 * Offering is the enforcement point: an id absent from every menu is never
 * emitted, and a stored default that falls out of this catalog is handled by
 * `resolveEditorState` / `resolveEffectiveDefaultEditor`. No handshake yet
 * (`null`) offers only the ids every minor carries.
 */
export function useOfferableEditors(
  hostId: string | null,
): ReadonlyArray<EditorEntry> {
  const version = useEditorOpenPathsVersion(hostId);
  const negotiatedMinor =
    version !== null && version.major === 1 ? version.minor : null;
  return useMemo(
    () =>
      EDITORS.filter(
        (editor) =>
          EDITOR_MINIMUM_MINOR[editor.id] === 0 ||
          (negotiatedMinor !== null &&
            negotiatedMinor >= EDITOR_MINIMUM_MINOR[editor.id]),
      ),
    [negotiatedMinor],
  );
}
