import {
  CONTEXT_USAGE_ROW_LABELS,
  CONTEXT_USAGE_ROW_KEYS,
} from "@/components/chat/context-usage";
import {
  registerCustomizeOptions,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import { recordSettingGesture } from "@/lib/customize/history";
import { useLayoutStore } from "@/stores/settings/layout-store";
import {
  useSettingsStore,
  type ContextIndicatorStyle,
  type MinimapPlacement,
} from "@/stores/settings/settings-store";

function movePinnedField(value: string, direction: -1 | 1): void {
  const order = useSettingsStore.getState().pinnedContextBreakdownOrder;
  const index = order.findIndex((field) => field === value);
  if (index === -1) return;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= order.length) return;
  const next = [...order];
  const swapped = next[index];
  next[index] = next[nextIndex];
  next[nextIndex] = swapped;
  recordSettingGesture(
    "pinnedContextBreakdownOrder",
    "Reorder context fields",
    ["settings"],
    () => useSettingsStore.getState().setPinnedContextBreakdownOrder(next),
  );
}

const MINIMAP_PLACEMENT_LABELS: Record<MinimapPlacement, string> = {
  left: "Left",
  right: "Right",
  hide: "Hidden",
};

export function registerChatSurfacesCustomizeOptions(): void {
  registerCustomizeOptions("chat.context", (): CustomizeOptions => {
    const settings = useSettingsStore.getState();
    const indicatorStyle = settings.contextIndicatorStyle;
    const pinned = settings.pinContextUsageBreakdown;
    const fields = settings.pinnedContextBreakdownFields;
    const order = settings.pinnedContextBreakdownOrder;
    const compactButton = useLayoutStore.getState().composer.compactButton;
    return {
      state: pinned ? "Pinned" : "Shown",
      control: {
        id: "chat.context",
        label: "Context usage",
        touches: ["settings"],
        analytics: "contextIndicatorStyle",
        kind: "composite",
        primary: {
          id: "chat.context.indicatorStyle",
          label: "Indicator style",
          touches: ["settings"],
          analytics: "contextIndicatorStyle",
          kind: "choice",
          value: indicatorStyle,
          options: [
            {
              value: "text",
              label: "Text",
              picture: null,
              override: { settings: { contextIndicatorStyle: "text" } },
            },
            {
              value: "ring",
              label: "Ring",
              picture: null,
              override: { settings: { contextIndicatorStyle: "ring" } },
            },
            {
              value: "ring-only",
              label: "Ring only",
              picture: null,
              override: { settings: { contextIndicatorStyle: "ring-only" } },
            },
          ],
          change: (value) => {
            if (value !== "text" && value !== "ring" && value !== "ring-only") {
              return;
            }
            const style: ContextIndicatorStyle = value;
            recordSettingGesture(
              "contextIndicatorStyle",
              "Change context indicator style",
              ["settings"],
              () => useSettingsStore.getState().setContextIndicatorStyle(style),
            );
          },
        },
        more: [
          {
            id: "chat.context.pin",
            label: "Pin breakdown",
            touches: ["settings"],
            analytics: "pinContextUsageBreakdown",
            kind: "toggle",
            checked: pinned,
            pictures: [],
            change: (checked) => {
              recordSettingGesture(
                "pinContextUsageBreakdown",
                checked ? "Pin context breakdown" : "Unpin context breakdown",
                ["settings"],
                () =>
                  useSettingsStore
                    .getState()
                    .setPinContextUsageBreakdown(checked),
              );
            },
          },
          {
            id: "chat.context.fields",
            label: "Pinned fields",
            touches: ["settings"],
            analytics: "pinnedContextBreakdownFields",
            kind: "multi",
            values: fields,
            lastItemHeld: true,
            moveItem: movePinnedField,
            options: order.map((field) => ({
              value: field,
              label: CONTEXT_USAGE_ROW_LABELS[field],
              picture: null,
              override: {},
            })),
            change: (values) => {
              const next = CONTEXT_USAGE_ROW_KEYS.filter((field) =>
                values.includes(field),
              );
              if (next.length === 0) return;
              recordSettingGesture(
                "pinnedContextBreakdownFields",
                "Change pinned context fields",
                ["settings"],
                () =>
                  useSettingsStore
                    .getState()
                    .setPinnedContextBreakdownFields(next),
              );
            },
          },
          {
            id: "chat.context.compactButton",
            label: "Compact button",
            touches: ["composer"],
            analytics: "layout.composer.compactButton",
            kind: "choice",
            value: compactButton,
            options: [
              {
                value: "visible",
                label: "Visible",
                picture: null,
                override: { composer: { compactButton: "visible" } },
              },
              {
                value: "hidden",
                label: "Hidden",
                picture: null,
                override: { composer: { compactButton: "hidden" } },
              },
            ],
            change: (value) => {
              recordSettingGesture(
                "layout.composer.compactButton",
                value === "hidden"
                  ? "Hide compact button"
                  : "Show compact button",
                ["composer"],
                () =>
                  useLayoutStore
                    .getState()
                    .setComposerCompactButton(
                      value === "hidden" ? "hidden" : "visible",
                    ),
              );
            },
          },
        ],
      },
      moves: [],
      drag: null,
    };
  });

  registerCustomizeOptions("chat.minimapSide", (): CustomizeOptions => {
    const side = useSettingsStore.getState().chatTurnMinimapSide;
    return {
      state: MINIMAP_PLACEMENT_LABELS[side],
      control: {
        id: "chat.minimapSide",
        label: "Minimap",
        touches: ["settings"],
        analytics: "chatTurnMinimapSide",
        kind: "choice",
        value: side,
        options: [
          {
            value: "left",
            label: "Left",
            picture: null,
            override: { settings: { chatTurnMinimapSide: "left" } },
          },
          {
            value: "right",
            label: "Right",
            picture: null,
            override: { settings: { chatTurnMinimapSide: "right" } },
          },
          {
            value: "hide",
            label: "Hidden",
            picture: null,
            override: { settings: { chatTurnMinimapSide: "hide" } },
          },
        ],
        change: (value) => {
          if (value !== "left" && value !== "right" && value !== "hide") return;
          const placement: MinimapPlacement = value;
          recordSettingGesture(
            "chatTurnMinimapSide",
            "Change minimap side",
            ["settings"],
            () => useSettingsStore.getState().setMinimapSide(placement),
          );
        },
      },
      // No literal two-droppable drag target (deviation, matching the
      // status bar's resource segment - see status-bar-options.ts): the
      // choice control above is the only way to move this rail today.
      moves: [],
      drag: null,
    };
  });
}
