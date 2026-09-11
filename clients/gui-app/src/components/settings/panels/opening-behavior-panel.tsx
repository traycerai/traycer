import type { ReactNode } from "react";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OPENING_BEHAVIOR } from "@/components/settings/panels/opening-behavior.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useSettingsRowDescriptionId } from "@/components/settings/settings-row-description";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { cn } from "@/lib/utils";
import { altLabel, modLabel, shiftLabel } from "@/lib/keybindings/platform";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
import {
  isAgentTabSurfacing,
  isBrowserTilePlacement,
  isLinkOpenDefault,
  isLinkOpenMode,
  isTilePlacement,
  isTilePlacementDefault,
  useSettingsStore,
  type AgentTabSurfacing,
  type BrowserTilePlacement,
  type LinkOpenMode,
  type LinkOpenSettings,
  type TilePlacement,
  type TilePlacementSettings,
} from "@/stores/settings/settings-store";

/**
 * Settings > Opening behavior: the one page that answers "where does the thing
 * I just clicked end up". Two groups - links (which surface a URL opens on)
 * and tile placement (this pane, a split, or picture-in-picture, plus what a
 * host-opened browser tab does, which is a placement question wearing another
 * name) - so the page reads as two questions rather than three.
 *
 * Every control is a plain enum select over the settings store. The modifier
 * keys that override a choice per click get ONE platform-aware legend under
 * the groups instead of a clause in each row's copy: none of them is
 * configurable, so repeating them per row spends description space that the
 * row's own scope needs.
 */

const LINK_OPEN_MODE_LABELS: Record<LinkOpenMode, string> = {
  "in-app": "In Traycer",
  external: "In default browser",
};
const LINK_OPEN_DEFAULT_LABELS: Record<LinkOpenSettings["default"], string> = {
  ...LINK_OPEN_MODE_LABELS,
  "per-kind": "Per link type",
};
/** Named for where the tile LANDS, not for the container it becomes. */
const TILE_PLACEMENT_LABELS: Record<TilePlacement, string> = {
  tab: "In this pane",
  split: "In a new split",
};
const TILE_PLACEMENT_DEFAULT_LABELS: Record<
  TilePlacementSettings["default"],
  string
> = {
  ...TILE_PLACEMENT_LABELS,
  "per-category": "Per tile type",
};
/**
 * A side chat is always placed relative to the chat it was asked from, so
 * "this pane" would be ambiguous here: the options name the SOURCE chat.
 */
const SIDE_CHAT_PLACEMENT_LABELS: Record<TilePlacement, string> = {
  tab: "As a tab of the source chat",
  split: "In a split beside the source chat",
};
/** Only the browser category can float - the other two have no PiP host. */
const BROWSER_TILE_PLACEMENT_LABELS: Record<BrowserTilePlacement, string> = {
  ...TILE_PLACEMENT_LABELS,
  pip: "Picture in picture",
};
const AGENT_TAB_SURFACING_LABELS: Record<AgentTabSurfacing, string> = {
  surface: "Like any browser tile",
  off: "Leave in the sidebar",
};

const TRIGGER_CLASS = "w-[min(60vw,12rem)]";

/**
 * A single-tile viewport has nowhere to put a split or a floating tile, so
 * every placement choice on this page collapses to "here". Said as the row's
 * status, in its description's place, rather than the amber hint: nothing is
 * wrong, and nothing was overridden - the window is simply narrow.
 */
const SINGLE_TILE_VIEWPORT_NOTE =
  "Narrow windows show one tile at a time, so everything opens in this pane.";

const MODIFIER_LEGEND = `${modLabel()}-click opens a link in your default browser · ${altLabel()}-click flips the choice · ${shiftLabel()}-click opens a tile in a split · middle-click opens it in the background`;

function trackOpeningBehaviorSetting(setting: AnalyticsSetting): void {
  trackSettingChanged("opening-behavior", setting);
}

export function OpeningBehaviorPanel(): ReactNode {
  const linkOpen = useSettingsStore((s) => s.linkOpen);
  const setLinkOpen = useSettingsStore((s) => s.setLinkOpen);
  const tilePlacement = useSettingsStore((s) => s.tilePlacement);
  const setTilePlacement = useSettingsStore((s) => s.setTilePlacement);
  const agentTabSurfacing = useSettingsStore((s) => s.agentTabSurfacing);
  const setAgentTabSurfacing = useSettingsStore((s) => s.setAgentTabSurfacing);
  const compact = useSettingsDensity() === "compact";
  const singleTileViewport = useIsMobileViewport();

  return (
    <SettingsPanelShell
      title="Opening behavior"
      description="Where links and tiles land when you open them."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <SettingsGroup
          group={OPENING_BEHAVIOR.definitions.links}
          showTitle
          tone="default"
          dataTestId="settings-opening-links"
          fill={false}
        >
          <SettingsRow
            row={OPENING_BEHAVIOR.definitions.openLinks}
            control={
              <EnumSelect
                labels={LINK_OPEN_DEFAULT_LABELS}
                isValue={isLinkOpenDefault}
                value={linkOpen.default}
                onValueChange={(value) => {
                  trackOpeningBehaviorSetting("linkOpen");
                  setLinkOpen({ default: value });
                }}
                ariaLabel="Open links"
              />
            }
          />
          {linkOpen.default === "per-kind" ? (
            <div className="bg-foreground/3">
              <LinkKindRow
                row={OPENING_BEHAVIOR.definitions.linkMarkdown}
                value={linkOpen.markdown}
                onValueChange={(markdown) => {
                  setLinkOpen({ markdown });
                }}
              />
              <LinkKindRow
                row={OPENING_BEHAVIOR.definitions.linkTerminal}
                value={linkOpen.terminal}
                onValueChange={(terminal) => {
                  setLinkOpen({ terminal });
                }}
              />
              <LinkKindRow
                row={OPENING_BEHAVIOR.definitions.linkGithub}
                value={linkOpen.github}
                onValueChange={(github) => {
                  setLinkOpen({ github });
                }}
              />
              <LinkKindRow
                row={OPENING_BEHAVIOR.definitions.linkImages}
                value={linkOpen.image}
                onValueChange={(image) => {
                  setLinkOpen({ image });
                }}
              />
            </div>
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          group={OPENING_BEHAVIOR.definitions.tilePlacement}
          showTitle
          tone="default"
          dataTestId="settings-opening-tiles"
          fill={false}
        >
          <SettingsRow
            row={OPENING_BEHAVIOR.definitions.openNewTiles}
            status={singleTileViewport ? SINGLE_TILE_VIEWPORT_NOTE : undefined}
            control={
              <EnumSelect
                labels={TILE_PLACEMENT_DEFAULT_LABELS}
                isValue={isTilePlacementDefault}
                value={tilePlacement.default}
                onValueChange={(value) => {
                  trackOpeningBehaviorSetting("tilePlacement");
                  setTilePlacement({ default: value });
                }}
                ariaLabel="Open new tiles"
              />
            }
          />
          {tilePlacement.default === "per-category" ? (
            <div className="bg-foreground/3">
              <SettingsRow
                row={OPENING_BEHAVIOR.definitions.tileContent}
                control={
                  <EnumSelect
                    labels={TILE_PLACEMENT_LABELS}
                    isValue={isTilePlacement}
                    value={tilePlacement.content}
                    onValueChange={(content) => {
                      trackOpeningBehaviorSetting("tilePlacement");
                      setTilePlacement({ content });
                    }}
                    ariaLabel="Files, diffs & artifacts"
                  />
                }
              />
              <SettingsRow
                row={OPENING_BEHAVIOR.definitions.tileConversation}
                control={
                  <EnumSelect
                    labels={TILE_PLACEMENT_LABELS}
                    isValue={isTilePlacement}
                    value={tilePlacement.conversation}
                    onValueChange={(conversation) => {
                      trackOpeningBehaviorSetting("tilePlacement");
                      setTilePlacement({ conversation });
                    }}
                    ariaLabel="Agents & terminals"
                  />
                }
              />
              <SettingsRow
                row={OPENING_BEHAVIOR.definitions.tileBrowser}
                control={
                  <EnumSelect
                    labels={BROWSER_TILE_PLACEMENT_LABELS}
                    isValue={isBrowserTilePlacement}
                    value={tilePlacement.browser}
                    onValueChange={(browser) => {
                      trackOpeningBehaviorSetting("tilePlacement");
                      setTilePlacement({ browser });
                    }}
                    ariaLabel="Browsers"
                  />
                }
              />
              <SettingsRow
                row={OPENING_BEHAVIOR.definitions.tileSideChat}
                control={
                  <EnumSelect
                    labels={SIDE_CHAT_PLACEMENT_LABELS}
                    isValue={isTilePlacement}
                    value={tilePlacement.sideChat}
                    onValueChange={(sideChat) => {
                      trackOpeningBehaviorSetting("tilePlacement");
                      setTilePlacement({ sideChat });
                    }}
                    ariaLabel="Side chats"
                  />
                }
              />
            </div>
          ) : null}
          <SettingsRow
            row={OPENING_BEHAVIOR.definitions.agentOpenedTabs}
            control={
              <EnumSelect
                labels={AGENT_TAB_SURFACING_LABELS}
                isValue={isAgentTabSurfacing}
                value={agentTabSurfacing}
                onValueChange={(value) => {
                  trackOpeningBehaviorSetting("agentTabSurfacing");
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

/** The four per-kind link rows differ only in copy and which field they set. */
function LinkKindRow(props: {
  readonly row: SettingsRowDefinition;
  readonly value: LinkOpenMode;
  readonly onValueChange: (value: LinkOpenMode) => void;
}): ReactNode {
  return (
    <SettingsRow
      row={props.row}
      control={
        <EnumSelect
          labels={LINK_OPEN_MODE_LABELS}
          isValue={isLinkOpenMode}
          value={props.value}
          onValueChange={(value) => {
            trackOpeningBehaviorSetting("linkOpen");
            props.onValueChange(value);
          }}
          ariaLabel={props.row.label}
        />
      }
    />
  );
}

/**
 * One `Select` over a string-union setting: the labels record supplies both
 * the options and their order, and the union's own store guard narrows what
 * Radix hands back. Moved here from `browser-settings-section.tsx` with the
 * controls it served.
 */
function EnumSelect<T extends string>(props: {
  /**
   * Options and their order. Each caller declares its own constant as
   * `Record<Union, string>`, so member coverage is checked there.
   */
  readonly labels: Readonly<Record<string, string>>;
  readonly value: T;
  readonly isValue: (value: string) => value is T;
  readonly onValueChange: (value: T) => void;
  /** Verbatim the row's visible label - a spoken name that matches what is read. */
  readonly ariaLabel: string;
}): ReactNode {
  // The row's description, spoken after the name instead of being lost.
  const describedById = useSettingsRowDescriptionId();
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (props.isValue(value)) props.onValueChange(value);
      }}
    >
      <SelectTrigger
        aria-label={props.ariaLabel}
        aria-describedby={describedById}
        className={TRIGGER_CLASS}
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(props.labels).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
