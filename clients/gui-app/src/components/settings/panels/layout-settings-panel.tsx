import type { ReactNode } from "react";
import {
  CONTEXT_USAGE_ROW_KEYS,
  CONTEXT_USAGE_ROW_LABELS,
} from "@/components/chat/context-usage";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { SettingsSubgroup } from "@/components/settings/controls/settings-subgroup";
import { SettingsToggleChips } from "@/components/settings/controls/settings-toggle-chips";
import { ComposerLayoutGroup } from "@/components/settings/panels/layout/composer-layout-group";
import { SidebarLayoutGroup } from "@/components/settings/panels/layout/sidebar-layout-group";
import { StatusBarLayoutGroup } from "@/components/settings/panels/layout/status-bar-layout-group";
import { TabsLayoutGroup } from "@/components/settings/panels/layout/tabs-layout-group";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Where the app's own chrome sits and how much of it shows, one group per
 * surface.
 *
 * The page exists because these controls answer a different question from
 * Appearance's ("where does this live", not "what does it look like") and
 * because they accumulate: a per-provider, per-window visibility list needs
 * room, and General and Appearance were already collecting layout toggles one
 * at a time. Group order is fixed - Status bar, then Tabs, then Composer when it
 * has rows, then Chat, then Sidebar - so a control keeps its place as groups
 * arrive.
 *
 * Each group is one file, mounted here on one line. That is what lets a group
 * grow a preview, a nested list or a host binding of its own without this file
 * changing, and what keeps two groups landing at once from meeting in the same
 * hunk.
 */
export function LayoutSettingsPanel(): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <SettingsPanelShell
      title="Layout"
      description="Where the app's chrome sits and how much of it shows."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <StatusBarLayoutGroup />
        <TabsLayoutGroup />
        <ComposerLayoutGroup />
        <ChatLayoutGroup />
        <SidebarLayoutGroup />
      </div>
    </SettingsPanelShell>
  );
}

/**
 * The message pane's own layout. These controls describe the pane rather than
 * the composer bar, which is why they are here and not in the composer group
 * that lands beside this one later.
 */
function ChatLayoutGroup(): ReactNode {
  const pinContextUsageBreakdown = useSettingsStore(
    (state) => state.pinContextUsageBreakdown,
  );
  const setPinContextUsageBreakdown = useSettingsStore(
    (state) => state.setPinContextUsageBreakdown,
  );
  const pinnedContextBreakdownFields = useSettingsStore(
    (state) => state.pinnedContextBreakdownFields,
  );
  const togglePinnedContextBreakdownField = useSettingsStore(
    (state) => state.togglePinnedContextBreakdownField,
  );
  const contextIndicatorStyle = useSettingsStore(
    (state) => state.contextIndicatorStyle,
  );
  const setContextIndicatorStyle = useSettingsStore(
    (state) => state.setContextIndicatorStyle,
  );
  const chatTurnMinimapSide = useSettingsStore(
    (state) => state.chatTurnMinimapSide,
  );
  const setMinimapSide = useSettingsStore((state) => state.setMinimapSide);
  return (
    <SettingsGroup
      group={LAYOUT.definitions.chat}
      showTitle
      tone="default"
      dataTestId="layout-chat-group"
      fill={false}
    >
      <SettingsSubgroup
        group={LAYOUT.definitions.pinContextBreakdown}
        icon={null}
        control={
          <Switch
            checked={pinContextUsageBreakdown}
            onCheckedChange={(value) => {
              trackLayoutSetting("pinContextUsageBreakdown");
              setPinContextUsageBreakdown(value);
            }}
            aria-label="Pin context breakdown"
          />
        }
        open={pinContextUsageBreakdown}
        level={3}
        dataTestId="layout-chat-pinned-context-subgroup"
      >
        <SettingsRow
          row={LAYOUT.definitions.pinnedFields}
          hint={
            pinnedContextBreakdownFields.length === 1
              ? "One field stays selected - use the switch above to hide the strip."
              : undefined
          }
          control={
            <SettingsToggleChips
              chips={CONTEXT_USAGE_ROW_KEYS.map((field) => ({
                value: field,
                label: CONTEXT_USAGE_ROW_LABELS[field],
                pressed: pinnedContextBreakdownFields.includes(field),
                // The last selected field is not a choice: the strip is never
                // drawn empty, and hiding it whole is the switch above.
                disabled:
                  pinnedContextBreakdownFields.length === 1 &&
                  pinnedContextBreakdownFields[0] === field,
              }))}
              onToggle={(field) => {
                trackLayoutSetting("pinnedContextBreakdownFields");
                togglePinnedContextBreakdownField(field);
              }}
              ariaLabel="Pinned breakdown fields"
              emptyLabel="No fields available"
            />
          }
        />
      </SettingsSubgroup>
      <SettingsRow
        row={LAYOUT.definitions.contextIndicator}
        control={
          <SettingsSegmentedControl
            value={contextIndicatorStyle}
            options={[
              { value: "text", label: "Text" },
              { value: "ring", label: "Ring" },
              { value: "ring-only", label: "Ring only" },
            ]}
            onChange={(style) => {
              trackLayoutSetting("contextIndicatorStyle");
              setContextIndicatorStyle(style);
            }}
            ariaLabel="Context indicator"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.minimapSide}
        control={
          <Select
            value={chatTurnMinimapSide}
            onValueChange={(value) => {
              if (value !== "left" && value !== "right" && value !== "hide") {
                return;
              }
              trackLayoutSetting("chatTurnMinimapSide");
              setMinimapSide(value);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Minimap position"
              className="w-[min(40vw,8rem)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="right">Right</SelectItem>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="hide">Hidden</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroup>
  );
}
