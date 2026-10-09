import { Fragment, type MouseEvent, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CustomizeLayoutMenuItem } from "@/components/layout-editor/customize-layout-menu-item";
import { setRegionShown } from "@/components/layout-editor/layout-gestures";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useArrangementValue, useRegionShown } from "@/lib/layout-overrides";
import {
  BAR_REGION_IDS,
  barPlacement,
  withBarHost,
  type BarRegionId,
} from "@/lib/layout/layout-arrangement";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * Marks a subtree the status bar's own right-click menu must not claim. The bar
 * is one strip of small controls that own their own menus and pointer
 * behaviour - the two panel triggers and the host notice's way out - and a menu
 * anchored on the whole bar would otherwise swallow theirs.
 */
export const STATUS_BAR_MENU_EXEMPT_ATTRIBUTE = "data-status-bar-menu-exempt";

export interface StatusBarMenuProvider {
  readonly providerId: RateLimitProviderId;
  readonly label: string;
}

interface StatusBarVisibilityMenuProps {
  /**
   * The providers the bar can currently show, in the order it shows them.
   * Passed in rather than resolved here: the bar has already resolved its
   * watched host's provider list, and a menu that resolved its own could name
   * a different set than the segments beside it.
   */
  readonly providers: ReadonlyArray<StatusBarMenuProvider>;
  /**
   * The readings the bar is DRAWING, in the order it draws them (L-159).
   *
   * Since L-156 each reading picks its own bar, so the menu cannot name one
   * by literal: it would offer verbs for a region drawn in the top bar, which
   * has its own menu up there, and a switch over a readout nowhere near the
   * pointer. Passed in for the same reason `providers` is - the bar has
   * already worked out what it is holding, and a second answer here could
   * disagree with the clusters beside it.
   */
  readonly regions: ReadonlyArray<BarRegionId>;
  /** The bar itself - the region a right-click opens this menu over. */
  readonly children: ReactNode;
}

/**
 * The status bar's quick-visibility menu: what each segment shows, without a
 * trip to Settings, plus the way to that page for everything else.
 *
 * Every item writes the same layout store the editor writes, so the two can
 * never disagree - this is a second view onto those values, never a second
 * place they live.
 */
export function StatusBarVisibilityMenu(
  props: StatusBarVisibilityMenuProps,
): ReactNode {
  const hiddenProviders = useArrangementValue("hiddenProviders");
  const shown: Readonly<Record<BarRegionId, boolean>> = {
    usageLimits: useRegionShown("usageLimits"),
    resourceMonitor: useRegionShown("resourceMonitor"),
  };
  const regions = props.regions;
  // The door names ONE region, and it is the first the bar draws: the editor
  // opens on it, and every other reading here is one click away in the index.
  // A bar drawing nothing opens the index instead of asserting a region.
  const doorTarget: BarRegionId | null = regions.length > 0 ? regions[0] : null;
  const setArrangement = useLayoutStore((state) => state.setArrangement);
  // Below `md` this footer draws both readings whatever bar they name (L-162)
  // and `MobileAppHeader` keeps its own copies either way, so the item would
  // write a value with no visible effect on the viewport it was pressed on,
  // and leave it waiting for the next desktop window.
  const narrowViewport = useIsMobileViewport();
  // The rule before the door only between two groups that both drew something.
  const anyAbove =
    regions.length > 0 || props.providers.length > 0 || !narrowViewport;
  // Under Usage limits' own switch when the bar draws it, since they are its
  // providers; on their own otherwise.
  const providerItems = props.providers.map((provider) => (
    <ContextMenuCheckboxItem
      key={provider.providerId}
      checked={!hiddenProviders.includes(provider.providerId)}
      onCheckedChange={() => {
        // The whole arrangement is read at write time rather than
        // subscribed: this menu needs it only to spread it (G1-14).
        setArrangement({
          ...useLayoutStore.getState().arrangement,
          hiddenProviders: hiddenProviders.includes(provider.providerId)
            ? hiddenProviders.filter((id) => id !== provider.providerId)
            : [...hiddenProviders, provider.providerId],
        });
      }}
    >
      {provider.label}
    </ContextMenuCheckboxItem>
  ));

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event: MouseEvent<HTMLElement>) => {
          // Radix composes this ahead of its own opener and skips that opener
          // once the event is defaulted-prevented, so an exempt subtree keeps
          // whatever menu (or none) it owns.
          if (
            event.target instanceof Element &&
            event.target.closest(`[${STATUS_BAR_MENU_EXEMPT_ATTRIBUTE}]`) !==
              null
          ) {
            event.preventDefault();
          }
        }}
      >
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* One Show switch per reading the bar is drawing, the same for
            both (the section header's switch in the form): the registry
            gives these regions no quick verbs, so this is their one way to
            hide from here. Only a reading in THIS bar: a switch here over one
            drawn in the top bar would make something disappear up there
            because of a right-click down here (L-159). */}
        {regions.map((regionId) => (
          <Fragment key={regionId}>
            <ContextMenuCheckboxItem
              checked={shown[regionId]}
              onCheckedChange={(checked) => {
                setRegionShown(regionId, checked);
              }}
            >
              {regionFacts(regionId).name}
            </ContextMenuCheckboxItem>
            {regionId === "usageLimits" ? providerItems : null}
          </Fragment>
        ))}
        {regions.includes("usageLimits") ? null : providerItems}
        {narrowViewport ? null : (
          <ContextMenuItem
            onSelect={() => {
              // Everything this strip is still holding, each keeping its own
              // side (L-156). The menu belongs to the STRIP, so it moves what
              // the strip has; a reading already in the header is left alone.
              const arrangement = useLayoutStore.getState().arrangement;
              setArrangement(
                BAR_REGION_IDS.reduce(
                  (current, region) =>
                    barPlacement(current, region).host === "status-bar"
                      ? withBarHost(current, region, "header")
                      : current,
                  arrangement,
                ),
              );
            }}
          >
            Move to tab strip
          </ContextMenuItem>
        )}
        {anyAbove ? <ContextMenuSeparator /> : null}
        {/* The way in (L-19, L-159), which replaces the old jump to the
            Layout settings page: customizing is the editor's job now, and the
            door lands on that page by itself when the window is too narrow. */}
        <CustomizeLayoutMenuItem target={doorTarget} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
