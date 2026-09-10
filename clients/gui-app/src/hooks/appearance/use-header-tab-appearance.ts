import { useTabsStore } from "@/stores/tabs/store";
import { tabRefKey } from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";

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
          color: group?.color ?? customization?.color ?? null,
          icon: customization?.icon ?? null,
        },
      };
}
