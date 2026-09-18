import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import type { AnalyticsSetting } from "@/lib/analytics";
import type { CustomizeSettingId } from "@/lib/customize/customize-setting-id";

export type { CustomizeSettingId };

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
interface SettingInput {
  readonly definition: {
    readonly label: string;
    readonly keywords: ReadonlyArray<string>;
  };
  readonly kind: CustomizeSetting["kind"];
  readonly analytics: AnalyticsSetting;
}

function setting(
  id: CustomizeSettingId,
  input: SettingInput,
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
    label: input.definition.label,
    keywords: input.definition.keywords,
    kind: input.kind,
    analytics: input.analytics,
    absent: LOCATIONS[surface],
  };
}

const SETTING_INPUTS = {
  "statusBar.placement": {
    definition: LAYOUT.definitions.placement,
    kind: "choice",
    analytics: "layout.statusBar.placement",
  },
  "statusBar.usage": {
    definition: {
      label: LAYOUT.definitions.usageLimits.label,
      keywords: [
        ...LAYOUT.definitions.usageLimits.keywords,
        ...LAYOUT.definitions.percentMode.keywords,
        ...LAYOUT.definitions.resetTimer.keywords,
        ...LAYOUT.definitions.modeWord.keywords,
        ...LAYOUT.definitions.miniBar.keywords,
      ],
    },
    kind: "composite",
    analytics: "layout.statusBar.rateLimits.enabled",
  },
  "statusBar.provider": {
    definition: LAYOUT.definitions.providers,
    kind: "composite",
    analytics: "layout.statusBar.rateLimits.provider",
  },
  "statusBar.resources": {
    definition: LAYOUT.definitions.resourceMonitor,
    kind: "composite",
    analytics: "layout.statusBar.resources.enabled",
  },
  "header.usage": {
    definition: {
      label: LAYOUT.definitions.usageLimits.label,
      keywords: [
        ...LAYOUT.definitions.usageLimits.keywords,
        ...LAYOUT.definitions.percentMode.keywords,
        ...LAYOUT.definitions.resetTimer.keywords,
        ...LAYOUT.definitions.modeWord.keywords,
        ...LAYOUT.definitions.miniBar.keywords,
      ],
    },
    kind: "composite",
    analytics: "layout.statusBar.rateLimits.enabled",
  },
  "tabs.home": {
    definition: LAYOUT.definitions.homeTab,
    kind: "toggle",
    analytics: "homeTabEnabled",
  },
  "composer.attachImage": {
    definition: LAYOUT.definitions.composerAttachImage,
    kind: "choice",
    analytics: "layout.composer.attachImage",
  },
  "composer.access": {
    definition: LAYOUT.definitions.composerAccess,
    kind: "choice",
    analytics: "layout.composer.access",
  },
  "composer.harness": {
    definition: {
      label: "Provider",
      keywords: ["harness", "provider", "toolbar", "order"],
    },
    kind: "choice",
    analytics: "layout.composer.toolbarOrder",
  },
  "composer.model": {
    definition: {
      label: LAYOUT.definitions.composerReasoning.label,
      keywords: [
        ...LAYOUT.definitions.composerReasoning.keywords,
        ...LAYOUT.definitions.composerReasoningControl.keywords,
      ],
    },
    kind: "composite",
    analytics: "layout.composer.reasoningIndicator",
  },
  "composer.mic": {
    definition: LAYOUT.definitions.composerMic,
    kind: "choice",
    analytics: "layout.composer.mic",
  },
  "composer.filesChanged": {
    definition: LAYOUT.definitions.composerFilesChanged,
    kind: "choice",
    analytics: "layout.composer.filesChanged",
  },
  "composer.activeAgents": {
    definition: LAYOUT.definitions.composerActiveAgents,
    kind: "choice",
    analytics: "layout.composer.activeAgents",
  },
  "composer.background": {
    definition: LAYOUT.definitions.composerBackground,
    kind: "choice",
    analytics: "layout.composer.background",
  },
  "chat.context": {
    definition: {
      label: LAYOUT.definitions.contextIndicator.label,
      keywords: [
        ...LAYOUT.definitions.contextIndicator.keywords,
        ...LAYOUT.definitions.pinnedFields.keywords,
        ...LAYOUT.definitions.composerCompactButton.keywords,
      ],
    },
    kind: "composite",
    analytics: "contextIndicatorStyle",
  },
  "chat.minimapSide": {
    definition: LAYOUT.definitions.minimapSide,
    kind: "choice",
    analytics: "chatTurnMinimapSide",
  },
  "sidebar.panel": {
    definition: LAYOUT.definitions.sidebarPanels,
    kind: "toggle",
    analytics: "layout.sidebar.panelVisibility",
  },
  "sidebar.resourceChips": {
    definition: LAYOUT.definitions.sidebarResourceChips,
    kind: "multi",
    analytics: "layout.sidebar.resourceMetrics",
  },
} satisfies Record<CustomizeSettingId, SettingInput>;

function isCustomizeSettingId(key: string): key is CustomizeSettingId {
  return key in SETTING_INPUTS;
}

/**
 * Every setting, in declaration order. Keyed by the id union above, so a member
 * of the union with no entry, an entry the union does not name, and (as an
 * object literal) a duplicated id are each a compile error - the catalog cannot
 * drift from the ids the rest of the editor addresses settings by.
 */
export const CUSTOMIZE_CATALOG: ReadonlyArray<CustomizeSetting> = Object.keys(
  SETTING_INPUTS,
)
  .filter(isCustomizeSettingId)
  .map((id) => setting(id, SETTING_INPUTS[id]));

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
