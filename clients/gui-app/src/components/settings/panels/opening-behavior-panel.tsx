import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
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
 * I just clicked end up". Links (which surface a URL opens on), tile placement
 * (tab, split or picture-in-picture) and what a host-opened browser tab does
 * are three halves of the same question, so they share a panel instead of
 * hiding one each in Browser, Appearance and General.
 *
 * Every control is a plain enum select over the settings store - the modifier
 * keys that override a choice per click are stated in the row copy rather than
 * given rows of their own, because none of them is configurable.
 */

const LINK_OPEN_MODE_LABELS: Record<LinkOpenMode, string> = {
  "in-app": "In Traycer",
  external: "In default browser",
};
const LINK_OPEN_DEFAULT_LABELS: Record<LinkOpenSettings["default"], string> = {
  ...LINK_OPEN_MODE_LABELS,
  "per-kind": "Per kind",
};
const TILE_PLACEMENT_LABELS: Record<TilePlacement, string> = {
  tab: "As a tab",
  split: "In a split",
};
const TILE_PLACEMENT_DEFAULT_LABELS: Record<
  TilePlacementSettings["default"],
  string
> = {
  ...TILE_PLACEMENT_LABELS,
  "per-category": "Per category",
};
/** Only the browser category can float - the other two have no PiP host. */
const BROWSER_TILE_PLACEMENT_LABELS: Record<BrowserTilePlacement, string> = {
  ...TILE_PLACEMENT_LABELS,
  pip: "Picture in picture",
};
const AGENT_TAB_SURFACING_LABELS: Record<AgentTabSurfacing, string> = {
  surface: "Surface on canvas",
  off: "Off",
};

const DEFAULT_TRIGGER_CLASS = "w-[min(42vw,11rem)]";
const OVERRIDE_TRIGGER_CLASS = "w-[min(42vw,10rem)]";

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

  return (
    <SettingsPanelShell
      title="Opening behavior"
      description="Where links and tiles land when you open them."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <SettingsGroup
          title="Links"
          tone="default"
          dataTestId="settings-opening-links"
          fill={false}
        >
          <SettingsRow
            label="Open links"
            description="Ctrl/Cmd-click always opens in your default browser, and alt-click flips whichever choice applies."
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
                triggerClassName={DEFAULT_TRIGGER_CLASS}
              />
            }
          />
          {linkOpen.default === "per-kind" ? (
            <>
              <LinkKindRow
                label="Markdown"
                ariaLabel="Markdown links"
                description="Chat, artifacts, comm graph, and markdown previews."
                value={linkOpen.markdown}
                onValueChange={(markdown) => {
                  setLinkOpen({ markdown });
                }}
              />
              <LinkKindRow
                label="Terminal"
                ariaLabel="Terminal links"
                description="Plain terminal URLs and OSC-8 hyperlinks."
                value={linkOpen.terminal}
                onValueChange={(terminal) => {
                  setLinkOpen({ terminal });
                }}
              />
              <LinkKindRow
                label="GitHub"
                ariaLabel="GitHub links"
                description="Pull request rows, headers, commits, and worktree PR chips."
                value={linkOpen.github}
                onValueChange={(github) => {
                  setLinkOpen({ github });
                }}
              />
              <LinkKindRow
                label="Images"
                ariaLabel="Image links"
                description="Images opened from the lightbox."
                value={linkOpen.image}
                onValueChange={(image) => {
                  setLinkOpen({ image });
                }}
              />
            </>
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          title="Tile placement"
          tone="default"
          dataTestId="settings-opening-tiles"
          fill={false}
        >
          <SettingsRow
            label="Place new tiles"
            description="Shift-click opens in a split, and middle-click opens in the background."
            control={
              <EnumSelect
                labels={TILE_PLACEMENT_DEFAULT_LABELS}
                isValue={isTilePlacementDefault}
                value={tilePlacement.default}
                onValueChange={(value) => {
                  trackOpeningBehaviorSetting("tilePlacement");
                  setTilePlacement({ default: value });
                }}
                ariaLabel="Place new tiles"
                triggerClassName={DEFAULT_TRIGGER_CLASS}
              />
            }
          />
          {tilePlacement.default === "per-category" ? (
            <>
              <SettingsRow
                label="Content"
                description="Files, diffs, artifacts, pull requests, and command output."
                control={
                  <EnumSelect
                    labels={TILE_PLACEMENT_LABELS}
                    isValue={isTilePlacement}
                    value={tilePlacement.content}
                    onValueChange={(content) => {
                      trackOpeningBehaviorSetting("tilePlacement");
                      setTilePlacement({ content });
                    }}
                    ariaLabel="Content tiles"
                    triggerClassName={OVERRIDE_TRIGGER_CLASS}
                  />
                }
              />
              <SettingsRow
                label="Conversations"
                description="Chats, agents, and terminals."
                control={
                  <EnumSelect
                    labels={TILE_PLACEMENT_LABELS}
                    isValue={isTilePlacement}
                    value={tilePlacement.conversation}
                    onValueChange={(conversation) => {
                      trackOpeningBehaviorSetting("tilePlacement");
                      setTilePlacement({ conversation });
                    }}
                    ariaLabel="Conversation tiles"
                    triggerClassName={OVERRIDE_TRIGGER_CLASS}
                  />
                }
              />
              <SettingsRow
                label="Browser"
                description="Browser sessions and their tabs."
                control={
                  <EnumSelect
                    labels={BROWSER_TILE_PLACEMENT_LABELS}
                    isValue={isBrowserTilePlacement}
                    value={tilePlacement.browser}
                    onValueChange={(browser) => {
                      trackOpeningBehaviorSetting("tilePlacement");
                      setTilePlacement({ browser });
                    }}
                    ariaLabel="Browser tiles"
                    triggerClassName={OVERRIDE_TRIGGER_CLASS}
                  />
                }
              />
            </>
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          title="Agent-opened browser tabs"
          tone="default"
          dataTestId="settings-opening-agent-tabs"
          fill={false}
        >
          <SettingsRow
            label="Agent-opened tabs"
            description="Surfacing places the tab using the Browser placement above; off leaves it in the sidebar."
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
                triggerClassName={DEFAULT_TRIGGER_CLASS}
              />
            }
          />
        </SettingsGroup>
      </div>
    </SettingsPanelShell>
  );
}

/** The four per-kind link rows differ only in copy and which field they set. */
function LinkKindRow(props: {
  readonly label: string;
  /** Spoken name for the select - the visible label reads as a noun alone. */
  readonly ariaLabel: string;
  readonly description: string;
  readonly value: LinkOpenMode;
  readonly onValueChange: (value: LinkOpenMode) => void;
}): ReactNode {
  return (
    <SettingsRow
      label={props.label}
      description={props.description}
      control={
        <EnumSelect
          labels={LINK_OPEN_MODE_LABELS}
          isValue={isLinkOpenMode}
          value={props.value}
          onValueChange={(value) => {
            trackOpeningBehaviorSetting("linkOpen");
            props.onValueChange(value);
          }}
          ariaLabel={props.ariaLabel}
          triggerClassName={OVERRIDE_TRIGGER_CLASS}
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
  readonly ariaLabel: string;
  readonly triggerClassName: string;
}): ReactNode {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (props.isValue(value)) props.onValueChange(value);
      }}
    >
      <SelectTrigger
        aria-label={props.ariaLabel}
        className={props.triggerClassName}
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
