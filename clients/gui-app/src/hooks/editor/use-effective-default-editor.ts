import type { EditorId } from "@traycer/protocol/host";
import { useOfferableEditors } from "@/hooks/editor/use-offerable-editors";
import { resolveEffectiveDefaultEditor } from "@/lib/editor/editor-menu-catalog";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The editor id a surface with no menu may send to `hostId`.
 *
 * `defaultEditor` is one app-wide preference while `editor.openPaths` is
 * host-scoped, so the stored value is a preference and not a legal wire value
 * until a specific host has been asked. Surfaces that open "the user's editor"
 * without offering a choice resolve here rather than reading the store; menu
 * surfaces pass the same catalog to `resolveEditorState` instead.
 *
 * `hostId` is the host the request is SENT to - a tile's own bound host, never
 * the app-wide one, since that is the machine whose minor decides the parse.
 */
export function useEffectiveDefaultEditor(hostId: string | null): EditorId {
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const offerableEditors = useOfferableEditors(hostId);
  return resolveEffectiveDefaultEditor(offerableEditors, defaultEditor);
}
