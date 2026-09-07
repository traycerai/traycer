import { useOfferableOpenTargets } from "@/hooks/editor/use-offerable-open-targets";
import {
  resolveEffectiveDefaultEditor,
  type DefaultOpenTarget,
} from "@/lib/editor/editor-menu-catalog";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * `defaultEditor` is app-wide; `editor.openPaths` is host-scoped. `hostId` is the tile's bound host, never the app-wide one.
 */
export function useEffectiveDefaultEditor(
  hostId: string | null,
): DefaultOpenTarget {
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const offerableTargets = useOfferableOpenTargets(hostId);
  return resolveEffectiveDefaultEditor(offerableTargets, defaultEditor);
}
