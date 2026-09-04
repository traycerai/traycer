import { useOfferableOpenTargets } from "@/hooks/editor/use-offerable-open-targets";
import {
  resolveEffectiveDefaultEditor,
  type DefaultOpenTarget,
} from "@/lib/editor/editor-menu-catalog";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The target a surface with no menu may send to `hostId`.
 *
 * `defaultEditor` is one app-wide preference while `editor.openPaths` is
 * host-scoped, so the stored value is a preference and not a legal wire value
 * until a specific host has been asked. That applies to Finder as much as to an
 * editor: a stored `"finder"` is effective only where the Finder gate holds,
 * and falls back to the first offerable target on a remote, non-Mac, or too-old
 * host exactly as an unofferable editor does.
 *
 * `hostId` is the host the request is SENT to - a tile's own bound host, never
 * the app-wide one, since that is the machine whose minor decides the parse.
 */
export function useEffectiveDefaultEditor(
  hostId: string | null,
): DefaultOpenTarget {
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const offerableTargets = useOfferableOpenTargets(hostId);
  return resolveEffectiveDefaultEditor(offerableTargets, defaultEditor);
}
