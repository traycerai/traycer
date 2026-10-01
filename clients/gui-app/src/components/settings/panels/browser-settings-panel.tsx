import {
  BROWSER_SEARCH_ENGINE_LABELS,
  isBrowserSearchEngine,
} from "@/lib/browser-view/browser-search";
import type { ReactNode } from "react";
import { BROWSER } from "@/components/settings/panels/browser-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { cn } from "@/lib/utils";
import { shiftLabel } from "@/lib/keybindings/platform";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
import {
  isAgentTabSurfacing,
  isBrowserTilePlacement,
  useSettingsStore,
  type AgentTabSurfacing,
  type BrowserTilePlacement,
} from "@/stores/settings/settings-store";

import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import { EnumSelect } from "@/components/settings/settings-enum-select";

const BROWSER_TILE_PLACEMENT_LABELS: Record<BrowserTilePlacement, string> = {
  tab: "In this pane",
  split: "In a new split",
  pip: "Picture in picture",
};
const AGENT_TAB_SURFACING_LABELS: Record<AgentTabSurfacing, string> = {
  surface: "Like any browser tile",
  off: "Leave in the sidebar",
};

const SINGLE_TILE_VIEWPORT_NOTE =
  "Narrow windows show one tile at a time, so everything opens in this pane.";

const MODIFIER_LEGEND = `${shiftLabel()}-click opens a tile in a split · middle-click opens it in the background`;

function trackBrowserSetting(setting: AnalyticsSetting): void {
  trackSettingChanged("browser", setting);
}

export function BrowserSettingsPanel(): ReactNode {
  const searchEngine = useSettingsStore((s) => s.browserSearchEngine);
  const setSearchEngine = useSettingsStore((s) => s.setBrowserSearchEngine);
  const tilePlacement = useSettingsStore((s) => s.tilePlacement);
  const setTilePlacement = useSettingsStore((s) => s.setTilePlacement);
  const agentTabSurfacing = useSettingsStore((s) => s.agentTabSurfacing);
  const setAgentTabSurfacing = useSettingsStore((s) => s.setAgentTabSurfacing);
  const compact = useSettingsDensity() === "compact";
  const singleTileViewport = useIsMobileViewport();

  return (
    <SettingsPanelShell
      title={BROWSER.page.label}
      description={BROWSER.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <SettingsGroup
          group={BROWSER.definitions.search}
          showTitle
          tone="default"
          dataTestId="settings-browser-search"
          fill={false}
        >
          <SettingsRow
            row={BROWSER.definitions.searchEngine}
            control={
              <EnumSelect
                labels={BROWSER_SEARCH_ENGINE_LABELS}
                isValue={isBrowserSearchEngine}
                value={searchEngine}
                onValueChange={(value) => {
                  trackBrowserSetting("browserSearchEngine");
                  setSearchEngine(value);
                }}
                ariaLabel="Default search engine"
              />
            }
          />
        </SettingsGroup>
        <BrowserSettingsSection />
        <SettingsGroup
          group={BROWSER.definitions.browserPlacement}
          showTitle
          tone="default"
          dataTestId="settings-browser-placement"
          fill={false}
        >
          <SettingsRow
            row={BROWSER.definitions.tileBrowser}
            status={singleTileViewport ? SINGLE_TILE_VIEWPORT_NOTE : undefined}
            control={
              <EnumSelect
                labels={BROWSER_TILE_PLACEMENT_LABELS}
                isValue={isBrowserTilePlacement}
                value={
                  tilePlacement.default === "per-category"
                    ? tilePlacement.browser
                    : tilePlacement.default
                }
                onValueChange={(browser) => {
                  trackBrowserSetting("tilePlacement");
                  // Preserve other categories' effective placement when enabling overrides.
                  setTilePlacement(
                    tilePlacement.default === "per-category"
                      ? { browser }
                      : {
                          default: "per-category",
                          browser,
                          content: tilePlacement.default,
                          conversation: tilePlacement.default,
                          sideChat: tilePlacement.default,
                        },
                  );
                }}
                ariaLabel="Open browser tabs"
              />
            }
          />
        </SettingsGroup>
        <SettingsGroup
          group={BROWSER.definitions.agentTabs}
          showTitle
          tone="default"
          dataTestId="settings-opening-agent-tabs"
          fill={false}
        >
          <SettingsRow
            row={BROWSER.definitions.agentOpenedTabs}
            control={
              <EnumSelect
                labels={AGENT_TAB_SURFACING_LABELS}
                isValue={isAgentTabSurfacing}
                value={agentTabSurfacing}
                onValueChange={(value) => {
                  trackBrowserSetting("agentTabSurfacing");
                  setAgentTabSurfacing(value);
                }}
                ariaLabel="Agent-opened tabs"
              />
            }
          />
        </SettingsGroup>

        <p className="px-1 text-ui-sm text-muted-foreground">
          {MODIFIER_LEGEND}
        </p>
      </div>
    </SettingsPanelShell>
  );
}
