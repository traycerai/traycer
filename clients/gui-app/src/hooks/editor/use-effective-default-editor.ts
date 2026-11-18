import { useEditorAvailability } from "@/hooks/editor/use-editor-availability-query";
import { useFinderOpenAvailability } from "@/hooks/editor/use-finder-open-availability";
import { useOfferableEditors } from "@/hooks/editor/use-offerable-editors";
import {
  resolveOpenMenuState,
  type DefaultOpenTarget,
} from "@/lib/editor/editor-menu-catalog";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The target a surface with no menu may send to `hostId`, or `null` when this
 * machine has nothing to send it to (the surface then says which editors
 * Traycer can open - `useNoEditorInstalledNotice`).
 *
 * The rule is the menus' own, `resolveOpenMenuState`: the host's offerable
 * editors narrowed to the ones the install probe found (Finder is exempt, it
 * ships with the OS), then the stored default if it survives and the first
 * survivor if not. A stored editor the probe did not find is therefore never
 * sent - on a Code - OSS-only machine the settings store's `"vscode"` default
 * resolves to `"code-oss"`. A probe still in flight or failed offers the whole
 * catalog.
 *
 * `defaultEditor` is one app-wide preference while `editor.openPaths` is
 * host-scoped, so the stored value is a preference and not a legal wire value
 * until a specific host has been asked. That applies to Finder as much as to an
 * editor: a stored `"finder"` is effective only where the Finder gate holds.
 *
 * `hostId` is the host the request is SENT to - a tile's own bound host, never
 * the app-wide one, since that is the machine whose minor decides the parse.
 */
export function useEffectiveDefaultEditor(
  hostId: string | null,
): DefaultOpenTarget | null {
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const offerableEditors = useOfferableEditors(hostId);
  const finderAvailable = useFinderOpenAvailability(hostId);
  const availability = useEditorAvailability();
  return resolveOpenMenuState({
    catalog: offerableEditors,
    availableEditorIds: availability.data ?? null,
    finderAvailable,
    defaultTarget: defaultEditor,
  }).primaryTargetId;
}
