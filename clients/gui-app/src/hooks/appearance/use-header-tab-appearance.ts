import { useTabsStore } from "@/stores/tabs/store";
import { tabRefKey } from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";

/**
 * The tab as the strip paints it: what the user chose for it, over what its
 * kind ships.
 *
 * Three tiers, and the order is the whole of it. A group's colour wins,
 * because joining a group is the later and more deliberate choice; then the
 * tab's own customization; then the appearance the KIND was built with. That
 * last tier is what the layout editor's own amber tab rides on (L-87) - it is
 * a fact about the tab kind rather than something a user picked, and a hook
 * that overwrote it would leave the kind's field silently dead.
 *
 * The colour this returns is the WHOLE of that tab's paint, not a tint beside
 * it: while the tab is active `header-tab-visual.tsx` fills its silhouette
 * with this colour and leaves its edge to the ordinary border (L-138, L-163).
 * So the ordering above is load-bearing for the editor and
 * not only for user colours: a tier that displaced the kind's colour would not
 * merely retint this tab, it would replace the signal that says the window is
 * in an editing mode.
 */
export function useHeaderTabAppearance(
  tab: HeaderTab | null,
): HeaderTab | null {
  const customization = useTabsStore((state) =>
    tab === null ? undefined : state.customizations?.[tabRefKey(tab)],
  );
  const groupId = customization?.groupId ?? null;
  const group = useTabsStore((state) =>
    groupId === null ? undefined : state.groups?.[groupId],
  );
  return tab === null
    ? null
    : {
        ...tab,
        appearance: {
          color:
            group?.color ??
            customization?.color ??
            tab.appearance?.color ??
            null,
          icon: customization?.icon ?? tab.appearance?.icon ?? null,
        },
      };
}
