import {
  registerCustomizeOptions,
  type CustomizeMove,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import {
  moveTileId,
  moveTileIdBefore,
  orderedTileIds,
} from "@/lib/customize/instance-order";
import { recordSettingGesture } from "@/lib/customize/history";
import { useLayoutStore } from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { providerDisplayName } from "@/lib/provider-ordering";

const PROVIDER_ORDER_SETTING_ID = "statusBar.provider" as const;

function providerMoves(
  providerId: RateLimitProviderId,
  sceneId: string,
): ReadonlyArray<CustomizeMove> {
  const order = orderedTileIds(
    PROVIDER_ORDER_SETTING_ID,
    sceneId,
    "horizontal",
  );
  const directions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly delta: -1 | 1;
  }> = [
    { id: "left", label: "Move left", delta: -1 },
    { id: "right", label: "Move right", delta: 1 },
  ];
  return directions.map(({ id, label, delta }) => {
    const next = moveTileId(order, providerId, delta);
    return {
      id,
      label,
      announcement: `${providerDisplayName(providerId)} moved ${delta < 0 ? "left" : "right"}`,
      disabled: next === null,
      touches: ["statusBar"],
      analytics: "layout.statusBar.rateLimits.provider",
      run: () => {
        if (next === null) return;
        recordSettingGesture(
          "layout.statusBar.rateLimits.provider",
          label,
          ["statusBar"],
          () =>
            useLayoutStore
              .getState()
              .setStatusBarSegmentOrder(
                next as ReadonlyArray<RateLimitProviderId>,
              ),
        );
      },
    };
  });
}

export function registerStatusBarCustomizeOptions(): void {
  registerCustomizeOptions(
    "statusBar.placement",
    (instance): CustomizeOptions => {
      const layout = useLayoutStore.getState();
      const placement = layout.statusBar.placement;
      return {
        state: placement === "header" ? "Header" : "Status bar",
        control: {
          id: "statusBar.placement",
          label: "Usage cluster placement",
          touches: ["statusBar"],
          analytics: "layout.statusBar.placement",
          kind: "choice",
          value: placement,
          options: [
            {
              value: "status-bar",
              label: "Status bar",
              picture: null,
              override: { statusBar: { placement: "status-bar" } },
            },
            {
              value: "header",
              label: "Header",
              picture: null,
              override: { statusBar: { placement: "header" } },
            },
          ],
          change: (value) => {
            recordSettingGesture(
              "layout.statusBar.placement",
              value === "header"
                ? "Move usage to header"
                : "Move usage to status bar",
              ["statusBar"],
              () =>
                useLayoutStore
                  .getState()
                  .setStatusBarPlacement(
                    value === "header" ? "header" : "status-bar",
                  ),
            );
          },
        },
        moves: [],
        drag: {
          group: "status-bar-placement",
          axis: "both",
          resolveDrop: (overId) => {
            if (overId !== `header.usage@${instance.sceneId}:-`) return null;
            return {
              id: "drop",
              label: "Move usage to header",
              announcement: "Usage moved to the header",
              disabled: false,
              touches: ["statusBar"],
              analytics: "layout.statusBar.placement",
              run: () => {
                recordSettingGesture(
                  "layout.statusBar.placement",
                  "Move usage to header",
                  ["statusBar"],
                  () =>
                    useLayoutStore.getState().setStatusBarPlacement("header"),
                );
              },
            };
          },
        },
      };
    },
  );

  registerCustomizeOptions("statusBar.usage", (): CustomizeOptions => {
    const layout = useLayoutStore.getState();
    const rateLimits = layout.statusBar.rateLimits;
    return {
      state: rateLimits.enabled ? "Shown" : "Hidden",
      control: {
        id: "statusBar.usage",
        label: "Usage limits",
        touches: ["statusBar"],
        analytics: "layout.statusBar.rateLimits.enabled",
        kind: "composite",
        primary: {
          id: "statusBar.usage.enabled",
          label: "Usage limits",
          touches: ["statusBar"],
          analytics: "layout.statusBar.rateLimits.enabled",
          kind: "toggle",
          checked: rateLimits.enabled,
          pictures: [],
          change: (checked) => {
            recordSettingGesture(
              "layout.statusBar.rateLimits.enabled",
              checked ? "Show usage limits" : "Hide usage limits",
              ["statusBar"],
              () =>
                useLayoutStore
                  .getState()
                  .setStatusBarRateLimitsEnabled(checked),
            );
          },
        },
        more: [
          {
            id: "statusBar.usage.resourceSide",
            label: "Resource side",
            touches: ["statusBar"],
            analytics: "layout.statusBar.resources.enabled",
            kind: "choice",
            value: layout.statusBar.resourceSide,
            options: [
              {
                value: "left",
                label: "Left",
                picture: null,
                override: { statusBar: { resourceSide: "left" } },
              },
              {
                value: "right",
                label: "Right",
                picture: null,
                override: { statusBar: { resourceSide: "right" } },
              },
            ],
            change: (value) => {
              recordSettingGesture(
                "layout.statusBar.resources.enabled",
                "Move resource segment",
                ["statusBar"],
                () =>
                  useLayoutStore
                    .getState()
                    .setStatusBarResourceSide(
                      value === "left" ? "left" : "right",
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

  registerCustomizeOptions(
    "statusBar.provider",
    (instance): CustomizeOptions => {
      const providerId = instance.tileId as RateLimitProviderId;
      const layout = useLayoutStore.getState();
      const hidden =
        layout.statusBar.rateLimits.hiddenProviders.includes(providerId);
      return {
        state: hidden ? "Hidden" : "Visible",
        control: {
          id: `statusBar.provider.${providerId}`,
          label: providerDisplayName(providerId),
          touches: ["statusBar"],
          analytics: "layout.statusBar.rateLimits.provider",
          kind: "toggle",
          checked: !hidden,
          pictures: [],
          change: () => {
            recordSettingGesture(
              "layout.statusBar.rateLimits.provider",
              hidden
                ? `Show ${providerDisplayName(providerId)}`
                : `Hide ${providerDisplayName(providerId)}`,
              ["statusBar"],
              () =>
                useLayoutStore.getState().toggleStatusBarProvider(providerId),
            );
          },
        },
        moves: providerMoves(providerId, instance.sceneId),
        drag: {
          group: "status-bar-providers",
          axis: "horizontal",
          resolveDrop: (overId) => {
            const order = orderedTileIds(
              PROVIDER_ORDER_SETTING_ID,
              instance.sceneId,
              "horizontal",
            );
            const overTileId = overIdToTileId(overId);
            if (overTileId === null) return null;
            const next = moveTileIdBefore(order, providerId, overTileId);
            if (next === null) return null;
            return {
              id: "drop",
              label: "Reorder providers",
              announcement: `${providerDisplayName(providerId)} moved`,
              disabled: false,
              touches: ["statusBar"],
              analytics: "layout.statusBar.rateLimits.provider",
              run: () => {
                recordSettingGesture(
                  "layout.statusBar.rateLimits.provider",
                  "Reorder providers",
                  ["statusBar"],
                  () =>
                    useLayoutStore
                      .getState()
                      .setStatusBarSegmentOrder(
                        next as ReadonlyArray<RateLimitProviderId>,
                      ),
                );
              },
            };
          },
        },
      };
    },
  );

  registerCustomizeOptions("statusBar.resources", (): CustomizeOptions => {
    const layout = useLayoutStore.getState();
    const resources = layout.statusBar.resources;
    return {
      state: resources.enabled ? "Shown" : "Hidden",
      control: {
        id: "statusBar.resources",
        label: "Resource monitor",
        touches: ["statusBar"],
        analytics: "layout.statusBar.resources.enabled",
        kind: "composite",
        primary: {
          id: "statusBar.resources.enabled",
          label: "Resource monitor",
          touches: ["statusBar"],
          analytics: "layout.statusBar.resources.enabled",
          kind: "toggle",
          checked: resources.enabled,
          pictures: [],
          change: (checked) => {
            recordSettingGesture(
              "layout.statusBar.resources.enabled",
              checked ? "Show resource monitor" : "Hide resource monitor",
              ["statusBar"],
              () =>
                useLayoutStore.getState().setStatusBarResourcesEnabled(checked),
            );
          },
        },
        more: [
          {
            id: "statusBar.resources.metrics",
            label: "Metrics",
            touches: ["statusBar"],
            analytics: "layout.statusBar.resources.enabled",
            kind: "multi",
            values: resources.metrics,
            lastItemHeld: resources.metrics.length <= 1,
            moveItem: null,
            options: [
              { value: "cpu", label: "CPU", picture: null, override: {} },
              { value: "memory", label: "Memory", picture: null, override: {} },
              {
                value: "processes",
                label: "Processes",
                picture: null,
                override: {},
              },
            ],
            change: (values) => {
              const metric = (["cpu", "memory", "processes"] as const).find(
                (candidate) =>
                  values.includes(candidate) !==
                  resources.metrics.includes(candidate),
              );
              if (metric === undefined) return;
              recordSettingGesture(
                "layout.statusBar.resources.enabled",
                "Change resource metrics",
                ["statusBar"],
                () =>
                  useLayoutStore
                    .getState()
                    .toggleStatusBarResourceMetric(metric),
              );
            },
          },
        ],
      },
      moves: [
        {
          id: "move-side",
          label:
            resources.enabled && layout.statusBar.resourceSide === "left"
              ? "Move to right"
              : "Move to left",
          announcement: "Resource monitor moved",
          disabled: false,
          touches: ["statusBar"],
          analytics: "layout.statusBar.resources.enabled",
          run: () => {
            const nextSide =
              layout.statusBar.resourceSide === "left" ? "right" : "left";
            recordSettingGesture(
              "layout.statusBar.resources.enabled",
              "Move resource monitor",
              ["statusBar"],
              () =>
                useLayoutStore.getState().setStatusBarResourceSide(nextSide),
            );
          },
        },
      ],
      // No literal two-droppable drag target yet (deviation: the strip has no
      // dedicated drop zone flanking the usage slot); "Move to left/right"
      // above is the keyboard twin D25 requires and is currently the only
      // way to move this segment.
      drag: null,
    };
  });

  registerCustomizeOptions("header.usage", (instance): CustomizeOptions => {
    const layout = useLayoutStore.getState();
    const settings = useSettingsStore.getState();
    const placement = layout.statusBar.placement;
    return {
      state: placement === "header" ? "Header" : "Status bar",
      control: {
        id: "header.usage",
        label: "Usage cluster placement",
        touches: ["statusBar", "settings"],
        analytics: "layout.statusBar.placement",
        kind: "composite",
        primary: {
          id: "header.usage.placement",
          label: "Usage cluster placement",
          touches: ["statusBar"],
          analytics: "layout.statusBar.placement",
          kind: "choice",
          value: placement,
          options: [
            {
              value: "header",
              label: "Header",
              picture: null,
              override: { statusBar: { placement: "header" } },
            },
            {
              value: "status-bar",
              label: "Status bar",
              picture: null,
              override: { statusBar: { placement: "status-bar" } },
            },
          ],
          change: (value) => {
            recordSettingGesture(
              "layout.statusBar.placement",
              value === "header"
                ? "Move usage to header"
                : "Move usage to status bar",
              ["statusBar"],
              () =>
                useLayoutStore
                  .getState()
                  .setStatusBarPlacement(
                    value === "header" ? "header" : "status-bar",
                  ),
            );
          },
        },
        more: [
          {
            id: "header.usage.resourceMonitor",
            label: "Resource monitor button",
            touches: ["settings"],
            analytics: "layout.statusBar.resources.enabled",
            kind: "toggle",
            checked: settings.showGlobalResourceMonitor,
            pictures: [],
            change: (checked) => {
              recordSettingGesture(
                "layout.statusBar.resources.enabled",
                checked
                  ? "Show header resource button"
                  : "Hide header resource button",
                ["settings"],
                () =>
                  useSettingsStore
                    .getState()
                    .setShowGlobalResourceMonitor(checked),
              );
            },
          },
        ],
      },
      moves: [
        {
          id: "move-to-status-bar",
          label: "Move to status bar",
          announcement: "Usage moved to the status bar",
          disabled: placement !== "header",
          touches: ["statusBar"],
          analytics: "layout.statusBar.placement",
          run: () => {
            recordSettingGesture(
              "layout.statusBar.placement",
              "Move usage to status bar",
              ["statusBar"],
              () =>
                useLayoutStore.getState().setStatusBarPlacement("status-bar"),
            );
          },
        },
      ],
      drag: {
        group: "status-bar-placement",
        axis: "both",
        resolveDrop: (overId) => {
          if (overId !== `statusBar.placement@${instance.sceneId}:-`)
            return null;
          return {
            id: "drop",
            label: "Move usage to status bar",
            announcement: "Usage moved to the status bar",
            disabled: false,
            touches: ["statusBar"],
            analytics: "layout.statusBar.placement",
            run: () => {
              recordSettingGesture(
                "layout.statusBar.placement",
                "Move usage to status bar",
                ["statusBar"],
                () =>
                  useLayoutStore.getState().setStatusBarPlacement("status-bar"),
              );
            },
          };
        },
      },
    };
  });
}

function overIdToTileId(overId: string): RateLimitProviderId | null {
  const separatorIndex = overId.lastIndexOf(":");
  if (separatorIndex === -1) return null;
  return overId.slice(separatorIndex + 1) as RateLimitProviderId;
}
