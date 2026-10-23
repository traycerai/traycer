import { useMemo, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import {
  OrganizationContext,
  type OrganizationContextValue,
} from "@/hooks/organization/organization-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import { flattenStripItemRefs, type StripItem } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabCustomizations, TabGroups } from "@/stores/tabs/tab-groups";
import { FIXTURE_ORGANIZATION_OWNER_ID } from "./organization-seed";

/**
 * The account behind the groups `organization-seed.ts` puts on the strip, for
 * the fixtures whose drivers CHANGE a group's membership.
 *
 * The seed is the display plane alone. A drop into or out of an account group
 * is refused before the layout is written unless the account can be told about
 * it (`groupDropCannotBeSaved`), and that question is asked of this context -
 * so a fixture that drags a row into a group and has no context seeds a group
 * no drop can touch. A fixture that only measures where a group is drawn needs
 * the seed and nothing here.
 *
 * The view is DERIVED from the same stores the seed writes, so the two cannot
 * disagree: a view that did not hold the seeded group would pass the guard and
 * then send the wrong command.
 */
export function FixtureOrganizationContext(props: {
  readonly children: ReactNode;
}): ReactNode {
  const groups = useTabsStore((state) => state.groups);
  const customizations = useTabsStore((state) => state.customizations);
  const items = useTabsStore((state) => state.items);
  const tabsById = useEpicCanvasStore((state) => state.tabsById);
  const value = useMemo<OrganizationContextValue>(
    () => ({
      client: FIXTURE_CLIENT,
      supported: true,
      hostSupport: true,
      userId: FIXTURE_ORGANIZATION_OWNER_ID,
      view: organizationViewOf(groups, customizations, items, tabsById),
      register: () => () => undefined,
      // The account accepts what the drop sends. The move itself is written
      // to the tabs store by the drop, which is what the drivers read; this
      // is the report the guard insists on being able to make.
      command: () => Promise.resolve(undefined),
      refresh: () => Promise.resolve(undefined),
      openDialog: () => undefined,
    }),
    [groups, customizations, items, tabsById],
  );
  return (
    <OrganizationContext value={value}>{props.children}</OrganizationContext>
  );
}

/** Inert: nothing on the organization path in a fixture sends a request. */
const FIXTURE_CLIENT = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "fixture-request",
    handlers: {},
  }),
});

type CanvasTabs = Readonly<Record<string, EpicViewTab | undefined>>;

/**
 * The account's projection of what the tabs store holds: every stamped group,
 * its members in the order the strip draws them, and every stamped
 * appearance - each keyed by the task id the drop's own command uses.
 */
function organizationViewOf(
  groups: TabGroups | undefined,
  customizations: TabCustomizations | undefined,
  items: ReadonlyArray<StripItem>,
  tabsById: CanvasTabs,
): OrganizationView {
  // Equality, not truthiness: the account this context reports is the one
  // the fixtures sign in as and stamp with, so a row owned by anyone else is
  // not this account's to show. Truthiness would quietly adopt it.
  const drawn = Object.entries(groups ?? {}).filter(
    ([, group]) => group.organizationOwnerId === FIXTURE_ORGANIZATION_OWNER_ID,
  );
  const isDrawn = (groupId: string): boolean =>
    drawn.some(([id]) => id === groupId);
  const taskIdOf = (tabId: string): string | undefined =>
    tabsById[tabId]?.epicId;
  const nextPosition = new Map<string, number>();
  const memberships = items.flatMap((item) =>
    flattenStripItemRefs(item).flatMap((ref) => {
      if (ref.kind !== "epic") return [];
      const taskId = taskIdOf(ref.id);
      const groupId = customizations?.[`epic:${ref.id}`]?.groupId;
      if (taskId === undefined || !groupId || !isDrawn(groupId)) return [];
      const position = nextPosition.get(groupId) ?? 0;
      nextPosition.set(groupId, position + 1);
      return [{ taskId, groupId, position }];
    }),
  );
  return {
    catalog: [],
    groups: {
      version: "1",
      groups: drawn.map(([groupId, group], position) => ({
        groupId,
        name: group.name,
        color: group.color,
        position,
      })),
      memberships,
    },
    appearances: Object.entries(customizations ?? {}).flatMap(
      ([key, customization]) => {
        if (
          !key.startsWith("epic:") ||
          customization.organizationOwnerId !== FIXTURE_ORGANIZATION_OWNER_ID
        )
          return [];
        const taskId = taskIdOf(key.slice("epic:".length));
        return taskId === undefined
          ? []
          : [
              {
                taskId,
                version: "0",
                color: customization.color,
                icon: customization.icon,
              },
            ];
      },
    ),
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
}
