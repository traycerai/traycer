import { tabRefKey } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabCustomization, TabGroup } from "@/stores/tabs/tab-groups";
import type { TabRef } from "@/stores/tabs/types";

/**
 * Tab groups and tab appearances as the ACCOUNT holds them, for the fixtures
 * the real-Chrome specs drive.
 *
 * Groups, colours and icons are the account's: the only thing that writes one
 * into the tabs store is the organization projection
 * (`projectOrganizationToTabs`), and the strip draws an entry only while it
 * carries the owner it stamped (`drawnTabGroup`, `drawnTabCustomization`). A
 * client has no way to make one, so a fixture that needs a group on screen
 * writes what that projection would have written, with the same stamp, rather
 * than asking the store for a group it can no longer create.
 */

/** The account the browser fixtures are signed in as. */
export const FIXTURE_ORGANIZATION_OWNER_ID = "fixture-user";

/** A group as the account's projection holds it. */
export function organizationGroup(group: {
  readonly name: string;
  readonly color: string;
  readonly collapsed: boolean;
}): TabGroup {
  return { ...group, organizationOwnerId: FIXTURE_ORGANIZATION_OWNER_ID };
}

/** One tab's colour, icon and membership as the account's projection holds them. */
export function organizationCustomization(customization: {
  readonly color: string | null;
  readonly icon: string | null;
  readonly groupId: string | null;
}): TabCustomization {
  return {
    ...customization,
    organizationOwnerId: FIXTURE_ORGANIZATION_OWNER_ID,
  };
}

/**
 * Puts one of the account's groups on the strip, holding `refs`, keeping each
 * member's own colour and icon.
 *
 * The strip's own repair pass runs afterwards, as it does after every
 * projection, so the group's members end up contiguous and in strip order -
 * the same arrangement a group made through the account's command gets.
 */
export function seedOrganizationGroup(input: {
  readonly groupId: string;
  readonly name: string;
  readonly color: string;
  readonly collapsed: boolean;
  readonly refs: ReadonlyArray<TabRef>;
}): void {
  const state = useTabsStore.getState();
  const customizations = { ...state.customizations };
  for (const ref of input.refs) {
    const key = tabRefKey(ref);
    customizations[key] = organizationCustomization({
      color: customizations[key]?.color ?? null,
      icon: customizations[key]?.icon ?? null,
      groupId: input.groupId,
    });
  }
  useTabsStore.setState({
    groups: {
      ...state.groups,
      [input.groupId]: organizationGroup({
        name: input.name,
        color: input.color,
        collapsed: input.collapsed,
      }),
    },
    customizations,
  });
  useTabsStore.getState().repair();
  // The repair pass drops a membership whose group it cannot resolve, so this
  // says the group really landed - the check the retired `createGroup`'s null
  // return used to give a fixture.
  const settled = useTabsStore.getState().customizations;
  for (const ref of input.refs) {
    const key = tabRefKey(ref);
    if (settled?.[key]?.groupId !== input.groupId)
      throw new Error(`the seeded group does not hold ${key}`);
  }
}

/**
 * Repaints one of the account's groups, as a colour change in the account's
 * projection does: the entry is rewritten and this window's fold state kept.
 */
export function recolourOrganizationGroup(
  groupId: string,
  color: string,
): void {
  const groups = useTabsStore.getState().groups;
  const group = groups?.[groupId];
  if (group === undefined) throw new Error(`no group ${groupId} to repaint`);
  useTabsStore.setState({
    groups: {
      ...groups,
      [groupId]: organizationGroup({
        name: group.name,
        color,
        collapsed: group.collapsed,
      }),
    },
  });
}

/**
 * Takes a seeded group off the strip again, leaving its tabs ungrouped: the
 * teardown for a fixture page that later tests share.
 */
export function clearOrganizationGroup(groupId: string): void {
  const state = useTabsStore.getState();
  useTabsStore.setState({
    customizations: Object.fromEntries(
      Object.entries(state.customizations ?? {}).map(([key, customization]) => [
        key,
        customization.groupId === groupId
          ? { ...customization, groupId: null }
          : customization,
      ]),
    ),
  });
  // A group with no members left does not survive the repair pass.
  useTabsStore.getState().repair();
}
