/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import {
  HOST_OVERVIEW_TABS,
  HOST_OVERVIEW_TAB_GROUPS,
  isHostOverviewTab,
  type HostOverviewTab,
} from "@/components/settings/panels/host-overview.definitions";
import {
  HostOverviewSelectTabContext,
  type HostOverviewSelectTab,
  type HostOverviewTabBadges,
  type HostOverviewTabBodies,
} from "@/components/settings/panels/host-overview-tab-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";

/*
 * The components that draw the Overview's tabs. The tab state they are handed
 * - the selected tab, the hooks that move it, the select-tab seam - lives in
 * `host-overview-tab-state.ts`.
 */

/**
 * Provides `useHostOverviewSelectTab()` (`host-overview-tab-state.ts`) to the
 * header and every tab body.
 */
export function HostOverviewSelectTabProvider(props: {
  readonly selectTab: HostOverviewSelectTab;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <HostOverviewSelectTabContext value={props.selectTab}>
      {props.children}
    </HostOverviewSelectTabContext>
  );
}

/**
 * The tab bar and the tab bodies under the pinned host header.
 *
 * Every tab renders for every host in every state, so the bar never shifts
 * under the reader; each body decides for itself what it can show while the
 * host connects or cannot be reached.
 *
 * A VISITED tab stays mounted, hidden while inactive - the Permissions Rules
 * tab's rule - so a half-typed retention limit survives a look at Status.
 * Never before its first visit, so opening the page starts no read a tab the
 * reader never opens would make. Visited tabs live with this component, below
 * the per-host remount, so they reset when the page closes or the host
 * changes while the selected tab itself carries over.
 *
 * On desktop only the active body scrolls: the header and the bar are pinned,
 * and the body is as tall as its content up to the pane. The `md:` classes
 * are that whole model; below `md` nothing here is a scroll container and the
 * page scrolls as one, header included.
 */
export function HostOverviewTabs(props: {
  readonly tab: HostOverviewTab;
  readonly onSelectTab: HostOverviewSelectTab;
  readonly isMobile: boolean;
  readonly badges: HostOverviewTabBadges;
  readonly bodies: HostOverviewTabBodies;
  /**
   * The live update pill as a phone's full-width strip, drawn directly above
   * the section dropdown, or `null`. The panel passes it only while a section
   * other than Status is selected and the pill would show; on desktop it is
   * never drawn here, since the pill sits on the header's health line.
   */
  readonly phoneStrip: ReactNode;
}): ReactNode {
  const { tab, isMobile } = props;
  const [visited, setVisited] = useState<ReadonlySet<HostOverviewTab>>(
    () => new Set([tab]),
  );
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));

  // The phone has no triggers to label its panes, so each pane names itself
  // and drops the `aria-labelledby` Radix would point at a missing trigger.
  const contentLabel = (value: HostOverviewTab) =>
    isMobile
      ? {
          "aria-labelledby": undefined,
          "aria-label": HOST_OVERVIEW_TAB_GROUPS[value].label,
        }
      : {};

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        if (isHostOverviewTab(next)) props.onSelectTab(next);
      }}
      className="gap-0 md:min-h-0"
    >
      <div
        className={cn("shrink-0 px-5", isMobile && "flex flex-col gap-2 pb-3")}
      >
        {isMobile ? (
          <>
            {props.phoneStrip}
            <HostOverviewTabSelect
              tab={tab}
              onSelect={props.onSelectTab}
              badges={props.badges}
            />
          </>
        ) : (
          <TabsList
            variant="line"
            className="h-auto w-full max-w-full shrink-0 flex-wrap justify-start"
          >
            {HOST_OVERVIEW_TABS.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="flex-none"
                data-settings-anchor={
                  HOST_OVERVIEW_TAB_GROUPS[value].anchor ?? undefined
                }
                data-testid={`host-overview-tab-${value}`}
              >
                {HOST_OVERVIEW_TAB_GROUPS[value].label}
                {props.badges[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      </div>
      <div
        className="md:min-h-0 md:overflow-y-auto"
        data-testid="host-overview-tab-body"
      >
        {HOST_OVERVIEW_TABS.map((value) => (
          <TabsContent
            key={value}
            value={value}
            // Radix leaves a force-mounted pane visible, hence the class.
            forceMount={visited.has(value) ? true : undefined}
            className="data-[state=inactive]:hidden"
            data-testid={`host-overview-tab-panel-${value}`}
            {...contentLabel(value)}
          >
            {props.bodies[value]}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}

/**
 * The column most tab bodies share: their groups, stacked, inset from the
 * card's edges at the page's density.
 */
export function HostOverviewTabSections(props: {
  readonly children: ReactNode;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <div className={cn("flex flex-col", compact ? "gap-3.5 p-4" : "gap-5 p-5")}>
      {props.children}
    </div>
  );
}

/**
 * The phone presentation of the tab bar: one section dropdown naming the
 * active tab, as Permissions and Providers do, because a wrapped line bar is
 * two ragged rows of chrome on a phone. Its trigger carries the ACTIVE tab's
 * search anchor - the tab triggers do not exist here, and a search landing
 * switches the tab before it looks for the anchor, so the one it asks for is
 * always the one this trigger carries.
 */
function HostOverviewTabSelect(props: {
  readonly tab: HostOverviewTab;
  readonly onSelect: HostOverviewSelectTab;
  readonly badges: HostOverviewTabBadges;
}): ReactNode {
  return (
    <Select
      value={props.tab}
      onValueChange={(value) => {
        if (isHostOverviewTab(value)) props.onSelect(value);
      }}
    >
      <SelectTrigger
        aria-label="Section"
        className="w-full shrink-0"
        data-settings-anchor={
          HOST_OVERVIEW_TAB_GROUPS[props.tab].anchor ?? undefined
        }
        data-testid="host-overview-tab-select"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {HOST_OVERVIEW_TABS.map((value) => (
          <SelectItem key={value} value={value}>
            {HOST_OVERVIEW_TAB_GROUPS[value].label}
            {props.badges[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
