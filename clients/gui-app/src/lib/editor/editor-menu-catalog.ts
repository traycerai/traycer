import type { ComponentType } from "react";
import type { EditorEntry, EditorId } from "@traycer/protocol/host";
import {
  CursorIcon,
  VisualStudioCodeIcon,
  VSCodiumIcon,
  WindsurfIcon,
  ZedIcon,
  type EditorIconProps,
} from "@/components/icons/editor-icons";

export type EditorIconComponent = ComponentType<EditorIconProps>;

/** Keyed by `EditorId`, so a registry entry without an icon fails to compile. */
export const EDITOR_ICONS: Readonly<Record<EditorId, EditorIconComponent>> = {
  vscode: VisualStudioCodeIcon,
  cursor: CursorIcon,
  windsurf: WindsurfIcon,
  zed: ZedIcon,
  vscodium: VSCodiumIcon,
};

/**
 * The editor a surface with no menu sends - one that simply opens "the user's
 * editor". `catalog` is the target host's offerable set: a stored default that
 * host would reject at parse falls back to the first id it does accept.
 *
 * Deliberately NOT intersected with the installed-editor probe; these surfaces
 * open whatever is stored, installed or not.
 */
export function resolveEffectiveDefaultEditor(
  catalog: ReadonlyArray<EditorEntry>,
  defaultEditor: EditorId | null,
): EditorId {
  if (
    defaultEditor !== null &&
    catalog.some((editor) => editor.id === defaultEditor)
  ) {
    return defaultEditor;
  }
  return catalog[0]?.id ?? "vscode";
}

export interface EditorMenuState {
  readonly availableEditors: ReadonlyArray<EditorEntry>;
  readonly noEditorsAvailable: boolean;
  readonly primaryEditorId: EditorId | null;
}

/**
 * Resolves which editors a menu offers and which one its primary half opens,
 * by intersecting two independent narrowings:
 *
 * - `catalog` is what the HOST will accept (`useOfferableEditors`, keyed on the
 *   negotiated `editor.openPaths` minor);
 * - `availableEditorIds` is what is INSTALLED on this machine (the shell-local
 *   URL-scheme probe), or `null` while that probe is still in flight - shown as
 *   the full catalog rather than flashing an empty list.
 *
 * Lives outside any component so both the workspace header dropdown and the
 * file tree's row context menu resolve one list, not two that drift.
 */
export function resolveEditorState(
  catalog: ReadonlyArray<EditorEntry>,
  availableEditorIds: ReadonlyArray<EditorId> | null,
  defaultEditor: EditorId | null,
): EditorMenuState {
  const availableEditors =
    availableEditorIds === null
      ? catalog
      : catalog.filter((editor) => availableEditorIds.includes(editor.id));
  const noEditorsAvailable =
    availableEditorIds !== null && availableEditors.length === 0;

  const firstAvailableEditorId: EditorId | null =
    availableEditors.length > 0 ? availableEditors[0].id : null;
  let primaryEditorId: EditorId | null = null;
  if (!noEditorsAvailable) {
    // Tested against the RESOLVED list, not the raw probe: a default the host
    // does not accept must not become the primary and fail at parse.
    primaryEditorId =
      defaultEditor !== null &&
      availableEditors.some((editor) => editor.id === defaultEditor)
        ? defaultEditor
        : firstAvailableEditorId;
  }
  return { availableEditors, noEditorsAvailable, primaryEditorId };
}
