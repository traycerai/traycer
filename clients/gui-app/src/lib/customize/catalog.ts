import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import type { AnalyticsSetting } from "@/lib/analytics";

export type CustomizeSettingId =
  | "statusBar.placement"
  | "statusBar.usage"
  | "statusBar.provider"
  | "statusBar.resources"
  | "header.usage"
  | "tabs.home"
  | "composer.attachImage"
  | "composer.access"
  | "composer.harness"
  | "composer.model"
  | "composer.mic"
  | "composer.filesChanged"
  | "composer.activeAgents"
  | "composer.background"
  | "chat.context"
  | "chat.minimapSide"
  | "sidebar.panel"
  | "sidebar.resourceChips";

export interface CustomizeSetting {
  readonly id: CustomizeSettingId;
  readonly surface:
    | "statusBar"
    | "header"
    | "tabs"
    | "composer"
    | "chat"
    | "sidebar";
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly kind: "choice" | "toggle" | "multi" | "composite";
  readonly absent: {
    readonly where: string;
    readonly needs: "chat" | "epic" | "none";
  };
  readonly analytics: AnalyticsSetting;
}

const LOCATIONS: Record<
  CustomizeSetting["surface"],
  CustomizeSetting["absent"]
> = {
  composer: { where: "Composer · toolbar", needs: "chat" },
  chat: { where: "In the chat", needs: "chat" },
  sidebar: { where: "In the sidebar", needs: "epic" },
  statusBar: { where: "In the status bar", needs: "none" },
  header: { where: "In the header", needs: "none" },
  tabs: { where: "In the tab strip", needs: "none" },
};
function setting(
  id: CustomizeSettingId,
  definition: {
    readonly label: string;
    readonly keywords: ReadonlyArray<string>;
  },
  kind: CustomizeSetting["kind"],
  analytics: AnalyticsSetting,
): CustomizeSetting {
  const surfaces: ReadonlyArray<CustomizeSetting["surface"]> = [
    "statusBar",
    "header",
    "tabs",
    "composer",
    "chat",
    "sidebar",
  ];
  const surface =
    surfaces.find((value) => id.startsWith(`${value}.`)) ?? "composer";
  return {
    id,
    surface,
    label: definition.label,
    keywords: definition.keywords,
    kind,
    analytics,
    absent: LOCATIONS[surface],
  };
}

export const CUSTOMIZE_CATALOG: ReadonlyArray<CustomizeSetting> = [
  setting(
    "statusBar.placement",
    LAYOUT.definitions.placement,
    "choice",
    "layout.statusBar.placement",
  ),
  setting(
    "statusBar.usage",
    {
      label: LAYOUT.definitions.usageLimits.label,
      keywords: [
        ...LAYOUT.definitions.usageLimits.keywords,
        ...LAYOUT.definitions.percentMode.keywords,
        ...LAYOUT.definitions.resetTimer.keywords,
        ...LAYOUT.definitions.modeWord.keywords,
        ...LAYOUT.definitions.miniBar.keywords,
      ],
    },
    "composite",
    "layout.statusBar.rateLimits.enabled",
  ),
  setting(
    "statusBar.provider",
    LAYOUT.definitions.providers,
    "composite",
    "layout.statusBar.rateLimits.provider",
  ),
  setting(
    "statusBar.resources",
    LAYOUT.definitions.resourceMonitor,
    "composite",
    "layout.statusBar.resources.enabled",
  ),
  setting(
    "header.usage",
    {
      label: LAYOUT.definitions.usageLimits.label,
      keywords: [
        ...LAYOUT.definitions.usageLimits.keywords,
        ...LAYOUT.definitions.percentMode.keywords,
        ...LAYOUT.definitions.resetTimer.keywords,
        ...LAYOUT.definitions.modeWord.keywords,
        ...LAYOUT.definitions.miniBar.keywords,
      ],
    },
    "composite",
    "layout.statusBar.rateLimits.enabled",
  ),
  setting("tabs.home", LAYOUT.definitions.homeTab, "toggle", "homeTabEnabled"),
  setting(
    "composer.attachImage",
    LAYOUT.definitions.composerAttachImage,
    "choice",
    "layout.composer.attachImage",
  ),
  setting(
    "composer.access",
    LAYOUT.definitions.composerAccess,
    "choice",
    "layout.composer.access",
  ),
  setting(
    "composer.harness",
    {
      label: "Provider",
      keywords: ["harness", "provider", "toolbar", "order"],
    },
    "choice",
    "layout.composer.toolbarOrder",
  ),
  setting(
    "composer.model",
    {
      label: LAYOUT.definitions.composerReasoning.label,
      keywords: [
        ...LAYOUT.definitions.composerReasoning.keywords,
        ...LAYOUT.definitions.composerReasoningControl.keywords,
      ],
    },
    "composite",
    "layout.composer.reasoningIndicator",
  ),
  setting(
    "composer.mic",
    LAYOUT.definitions.composerMic,
    "choice",
    "layout.composer.mic",
  ),
  setting(
    "composer.filesChanged",
    LAYOUT.definitions.composerFilesChanged,
    "choice",
    "layout.composer.filesChanged",
  ),
  setting(
    "composer.activeAgents",
    LAYOUT.definitions.composerActiveAgents,
    "choice",
    "layout.composer.activeAgents",
  ),
  setting(
    "composer.background",
    LAYOUT.definitions.composerBackground,
    "choice",
    "layout.composer.background",
  ),
  setting(
    "chat.context",
    {
      label: LAYOUT.definitions.contextIndicator.label,
      keywords: [
        ...LAYOUT.definitions.contextIndicator.keywords,
        ...LAYOUT.definitions.pinnedFields.keywords,
        ...LAYOUT.definitions.composerCompactButton.keywords,
      ],
    },
    "composite",
    "contextIndicatorStyle",
  ),
  setting(
    "chat.minimapSide",
    LAYOUT.definitions.minimapSide,
    "choice",
    "chatTurnMinimapSide",
  ),
  setting(
    "sidebar.panel",
    LAYOUT.definitions.sidebarPanels,
    "toggle",
    "layout.sidebar.panelVisibility",
  ),
  setting(
    "sidebar.resourceChips",
    LAYOUT.definitions.sidebarResourceChips,
    "multi",
    "layout.sidebar.resourceMetrics",
  ),
];

export function getCustomizeSetting(id: CustomizeSettingId): CustomizeSetting {
  const entry = CUSTOMIZE_CATALOG.find((item) => item.id === id);
  if (!entry) throw new Error(`Unknown layout setting: ${id}`);
  return entry;
}

export function searchCustomizeSettings(
  query: string,
): ReadonlyArray<CustomizeSetting> {
  const words = query.toLocaleLowerCase().trim().split(/\s+/);
  return CUSTOMIZE_CATALOG.filter((entry) =>
    words.every((word) =>
      [entry.label, ...entry.keywords]
        .join(" ")
        .toLocaleLowerCase()
        .includes(word),
    ),
  );
}
