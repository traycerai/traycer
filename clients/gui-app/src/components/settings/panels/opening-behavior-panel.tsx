import type { ReactNode } from "react";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import { EnumSelect } from "@/components/settings/settings-enum-select";
import { OPENING_BEHAVIOR } from "@/components/settings/panels/opening-behavior.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { cn } from "@/lib/utils";
import { altLabel, modLabel, shiftLabel } from "@/lib/keybindings/platform";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
import {
  isLinkOpenDefault,
  isLinkOpenMode,
  type LinkOpenMode,
  type LinkOpenSettings,
  isTilePlacement,
  isTilePlacementDefault,
  useSettingsStore,
  type TilePlacement,
  type TilePlacementSettings,
} from "@/stores/settings/settings-store";

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
                row={OPENING_BEHAVIOR.definitions.tileSideChat}
                control={
                  <EnumSelect
                    labels={TILE_PLACEMENT_LABELS}
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
