import type { MouseEvent, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { trackSettingChanged } from "@/lib/analytics";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useLayoutStore } from "@/stores/settings/layout-store";

/**
 * Marks a subtree the status bar's own right-click menu must not claim. The bar
 * is one strip of small controls that own their own menus and pointer
 * behaviour - the host switcher chip most of all - and a menu anchored on the
 * whole bar would otherwise swallow theirs.
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
  /** The bar itself - the region a right-click opens this menu over. */
  readonly children: ReactNode;
}

/**
 * The status bar's quick-visibility menu: what each segment shows, without a
 * trip to Settings, plus the way to that page for everything else.
 *
 * Every item writes the same `layout-store` fields the Layout page writes, so
 * the two can never disagree - this is a second view onto those preferences,
 * never a second place they live.
 */
export function StatusBarVisibilityMenu(
  props: StatusBarVisibilityMenuProps,
): ReactNode {
  const hiddenProviders = useLayoutStore(
    (state) => state.statusBar.rateLimits.hiddenProviders,
  );
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
  const toggleProvider = useLayoutStore(
    (state) => state.toggleStatusBarProvider,
  );
  const setResourcesEnabled = useLayoutStore(
    (state) => state.setStatusBarResourcesEnabled,
  );
  const setPlacement = useLayoutStore((state) => state.setStatusBarPlacement);

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
        {props.providers.map((provider) => (
          <ContextMenuCheckboxItem
            key={provider.providerId}
            checked={!hiddenProviders.includes(provider.providerId)}
            onCheckedChange={() => {
              trackSettingChanged(
                "layout",
                "layout.statusBar.rateLimits.provider",
              );
              toggleProvider(provider.providerId);
            }}
          >
            {provider.label}
          </ContextMenuCheckboxItem>
        ))}
        <ContextMenuCheckboxItem
          checked={resourcesEnabled}
          onCheckedChange={(checked) => {
            trackSettingChanged("layout", "layout.statusBar.resources.enabled");
            setResourcesEnabled(checked);
          }}
        >
          Resource monitor
        </ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            navigateToSettingsSection("layout");
          }}
        >
          Status bar settings…
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            trackSettingChanged("layout", "layout.statusBar.placement");
            setPlacement("header");
          }}
        >
          Move to header
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
