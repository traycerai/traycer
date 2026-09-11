import {
  useLayoutStore,
  type HomeDensity,
} from "@/stores/settings/layout-store";

/**
 * The Home tab's row spacing, read where it is rendered rather than threaded
 * down as a prop.
 *
 * Every row shape on the page wants it, at every nesting level the Tasks view
 * reaches, and it is client UI state in a store the rows can subscribe to
 * directly - so a prop would be the same value copied through six components
 * that have no other reason to know about it.
 */
export function useHomeDensity(): HomeDensity {
  return useLayoutStore((state) => state.home.density);
}
