import {
  registerCustomizeOptions,
  type CustomizeMove,
  type CustomizeControl,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import {
  moveTileId,
  moveTileIdBefore,
  orderedTileIds,
} from "@/lib/customize/instance-order";
import { useLayoutStore } from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { mergeOrder } from "@/lib/order-merge";
import {
  ORDERED_PROVIDERS,
  providerDisplayName,
} from "@/lib/provider-ordering";

const PROVIDER_ORDER_SETTING_ID = "statusBar.provider" as const;

function providerIdForTile(tileId: string | null): RateLimitProviderId | null {
  return (
    rateLimitCapableProviderIdSchema.options.find(
      (id) => id === tileId?.split(":")[0],
    ) ?? null
  );
}
function providerOrder(sceneId: string): ReadonlyArray<RateLimitProviderId> {
  return [
    ...new Set(
      orderedTileIds(PROVIDER_ORDER_SETTING_ID, sceneId, "horizontal").flatMap(
        (tileId) => {
          const id = providerIdForTile(tileId);
          return id === null ? [] : [id];
        },
      ),
    ),
  ];
}
function typedProviderOrder(
  order: ReadonlyArray<string>,
): ReadonlyArray<RateLimitProviderId> {
  return order.flatMap((value) => {
    const id = providerIdForTile(value);
    return id === null ? [] : [id];
  });
}

function providerMoves(
  providerId: RateLimitProviderId,
  sceneId: string,
): ReadonlyArray<CustomizeMove> {
  const order = providerOrder(sceneId);
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
      analytics: "layout.statusBar.segmentOrder",
      run: () => {
        if (next === null) return;
        useLayoutStore
          .getState()
          .setStatusBarSegmentOrder(typedProviderOrder(next));
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
        control: footerControls({
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
            useLayoutStore
              .getState()
              .setStatusBarPlacement(
                value === "header" ? "header" : "status-bar",
              );
          },
        }),
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
                useLayoutStore.getState().setStatusBarPlacement("header");
              },
            };
          },
        },
      };
    },
  );

  registerCustomizeOptions("statusBar.usage", (instance): CustomizeOptions => {
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
        primary: usageDisplayControls({
          id: "statusBar.usage.enabled",
          label: "Usage limits",
          touches: ["statusBar"],
          analytics: "layout.statusBar.rateLimits.enabled",
          kind: "toggle",
          checked: rateLimits.enabled,
          pictures: [],
          change: (checked) => {
            useLayoutStore.getState().setStatusBarRateLimitsEnabled(checked);
          },
        }),
        more: [
          {
            id: "statusBar.usage.resourceSide",
            label: "Resource side",
            touches: ["statusBar"],
            analytics: "layout.statusBar.resourceSide",
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
              useLayoutStore
                .getState()
                .setStatusBarResourceSide(value === "left" ? "left" : "right");
            },
          },
        ],
      },
      moves: [],
      drag: {
        group: "status-bar-placement",
        axis: "both",
        resolveDrop: (overId) =>
          overId === `header.usage@${instance.sceneId}:-`
            ? {
                id: "drop",
                label: "Move usage to header",
                announcement: "Usage moved to the header",
                disabled: false,
                touches: ["statusBar"],
                analytics: "layout.statusBar.placement",
                run: () =>
                  useLayoutStore.getState().setStatusBarPlacement("header"),
              }
            : null,
      },
    };
  });

  registerCustomizeOptions(
    "statusBar.provider",
    (instance): CustomizeOptions => {
      const providerId = providerIdForTile(instance.tileId);
      if (providerId === null)
        return { state: "Unavailable", control: null, moves: [], drag: null };
      const layout = useLayoutStore.getState();
      const hidden =
        layout.statusBar.rateLimits.hiddenProviders.includes(providerId);
      return {
        state: hidden ? "Hidden" : "Visible",
        control: providerControls(providerId, {
          id: `statusBar.provider.${providerId}`,
          label: providerDisplayName(providerId),
          touches: ["statusBar"],
          analytics: "layout.statusBar.rateLimits.provider",
          kind: "toggle",
          checked: !hidden,
          pictures: [],
          change: () => {
            useLayoutStore.getState().toggleStatusBarProvider(providerId);
          },
        }),
        moves: providerMoves(providerId, instance.sceneId),
        drag: {
          group: "status-bar-providers",
          axis: "horizontal",
          resolveDrop: (overId) => {
            const order = providerOrder(instance.sceneId);
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
              analytics: "layout.statusBar.segmentOrder",
              run: () => {
                useLayoutStore
                  .getState()
                  .setStatusBarSegmentOrder(typedProviderOrder(next));
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
            useLayoutStore.getState().setStatusBarResourcesEnabled(checked);
          },
        },
        more: [
          {
            id: "statusBar.resources.scope",
            label: "Scope",
            kind: "choice",
            touches: ["statusBar"],
            analytics: "layout.statusBar.resources.scope",
            value: resources.scope,
            options: (["host-tree", "desktop-app"] as const).map((value) => ({
              value,
              label: value === "host-tree" ? "Host and agents" : "Desktop app",
              picture: null,
              override: { statusBar: { resources: { scope: value } } },
            })),
            change: (value) => {
              if (value === "host-tree" || value === "desktop-app")
                useLayoutStore.getState().setStatusBarResourceScope(value);
            },
          },
          resourceMetricsControl(),
        ],
      },
      moves: [
        {
          id: "move-side",
          label:
            layout.statusBar.resourceSide === "left"
              ? "Move to right"
              : "Move to left",
          announcement: "Resource monitor moved",
          disabled: false,
          touches: ["statusBar"],
          analytics: "layout.statusBar.resourceSide",
          run: () => {
            const nextSide =
              layout.statusBar.resourceSide === "left" ? "right" : "left";
            useLayoutStore.getState().setStatusBarResourceSide(nextSide);
          },
        },
      ],
      drag: {
        group: "status-bar-resources",
        axis: "horizontal",
        resolveDrop: (overId) => {
          const side =
            (["left", "right"] as const).find((side) =>
              overId.startsWith(`resources:${side}@`),
            ) ?? null;
          if (side === null) return null;
          return {
            id: "drop",
            label: "Move resource monitor",
            announcement: `Resource monitor moved ${side}`,
            disabled: false,
            touches: ["statusBar"],
            analytics: "layout.statusBar.resourceSide",
            run: () => useLayoutStore.getState().setStatusBarResourceSide(side),
          };
        },
      },
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
            useLayoutStore
              .getState()
              .setStatusBarPlacement(
                value === "header" ? "header" : "status-bar",
              );
          },
        },
        more: [
          usageToggle(),
          {
            id: "header.usage.resourceMonitor",
            label: "Resource monitor button",
            touches: ["settings"],
            analytics: "showGlobalResourceMonitor",
            kind: "toggle",
            checked: settings.showGlobalResourceMonitor,
            pictures: [],
            change: (checked) => {
              useSettingsStore.getState().setShowGlobalResourceMonitor(checked);
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
            useLayoutStore.getState().setStatusBarPlacement("status-bar");
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
              useLayoutStore.getState().setStatusBarPlacement("status-bar");
            },
          };
        },
      },
    };
  });
}

function overIdToTileId(overId: string): RateLimitProviderId | null {
  const separatorIndex = overId.indexOf(":", overId.indexOf("@"));
  if (separatorIndex === -1) return null;
  return providerIdForTile(overId.slice(separatorIndex + 1));
}

function usageToggle(): CustomizeControl {
  return {
    id: "statusBar.usage.enabled",
    label: "Usage limits",
    kind: "toggle",
    touches: ["statusBar"],
    analytics: "layout.statusBar.rateLimits.enabled",
    checked: useLayoutStore.getState().statusBar.rateLimits.enabled,
    pictures: [],
    change: (checked) =>
      useLayoutStore.getState().setStatusBarRateLimitsEnabled(checked),
  };
}
function footerDisplayControls(): ReadonlyArray<CustomizeControl> {
  const store = useLayoutStore.getState();
  const prefs = store.statusBar.rateLimits;
  return [
    {
      id: "statusBar.usage.percentMode",
      label: "Percentage",
      kind: "choice",
      touches: ["statusBar"],
      analytics: "layout.statusBar.rateLimits.percentMode",
      value: prefs.percentMode,
      options: (["used", "remaining"] as const).map((value) => ({
        value,
        label: value === "used" ? "Used" : "Remaining",
        picture: null,
        override: { statusBar: { rateLimits: { percentMode: value } } },
      })),
      change: (value) => {
        if (value === "used" || value === "remaining")
          store.setStatusBarPercentMode(value);
      },
    },
    ...(
      [
        {
          key: "showModeWord",
          label: "Mode word",
          change: store.setStatusBarShowModeWord,
          analytics: "layout.statusBar.rateLimits.showModeWord",
        },
        {
          key: "showTimer",
          label: "Timer",
          change: store.setStatusBarShowTimer,
          analytics: "layout.statusBar.rateLimits.showTimer",
        },
        {
          key: "showBar",
          label: "Mini bar",
          change: store.setStatusBarShowBar,
          analytics: "layout.statusBar.rateLimits.showBar",
        },
      ] as const
    ).map(({ key, label, change, analytics }): CustomizeControl => ({
      id: `statusBar.usage.${key}`,
      label,
      change,
      analytics,
      touches: ["statusBar"],
      kind: "toggle",
      checked: prefs[key],
      pictures: [],
    })),
  ];
}
function usageDisplayControls(primary: CustomizeControl): CustomizeControl {
  return {
    id: "statusBar.display",
    label: "Usage display",
    touches: ["statusBar"],
    analytics: "layout.statusBar.rateLimits.enabled",
    kind: "group",
    controls: [primary, ...footerDisplayControls()],
  };
}
function footerControls(placement: CustomizeControl): CustomizeControl {
  return {
    id: "statusBar.footer",
    label: "Status bar",
    touches: ["statusBar"],
    analytics: "layout.statusBar.placement",
    kind: "group",
    controls: [
      placement,
      {
        id: "statusBar.footerOnly",
        label: "Shown when placement is Status bar",
        kind: "group",
        touches: ["statusBar"],
        analytics: "layout.statusBar.rateLimits.enabled",
        controls: [
          usageToggle(),
          ...footerDisplayControls(),
          footerProvidersControl(),
          resourceMetricsControl(),
        ],
      },
    ],
  };
}
function providerControls(
  providerId: RateLimitProviderId,
  primary: CustomizeControl,
): CustomizeControl {
  return {
    ...primary,
    kind: "composite",
    primary,
    more: [
      {
        id: "statusBar.provider.limits",
        label: "Limits",
        touches: ["statusBar"],
        analytics: "layout.statusBar.rateLimits.providerLimits",
        kind: "provider-limits",
        providerId,
      },
    ],
  };
}

function resourceMetricsControl(): CustomizeControl {
  const resources = useLayoutStore.getState().statusBar.resources;
  return {
    id: "statusBar.resources.metrics",
    label: "Metrics",
    touches: ["statusBar"],
    analytics: "layout.statusBar.resources.metric",
    kind: "multi",
    values: resources.metrics,
    lastItemHeld: resources.metrics.length <= 1,
    moveItem: null,
    options: [
      { value: "ramShare", label: "RAM share", picture: null, override: {} },
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
      const metric = (["cpu", "memory", "processes", "ramShare"] as const).find(
        (candidate) =>
          values.includes(candidate) !== resources.metrics.includes(candidate),
      );
      if (metric === undefined) return;
      useLayoutStore.getState().toggleStatusBarResourceMetric(metric);
    },
  };
}

function footerProvidersControl(): CustomizeControl {
  const { segmentOrder: savedOrder, rateLimits } =
    useLayoutStore.getState().statusBar;
  const canonical = ORDERED_PROVIDERS.flatMap(({ providerId }) => {
    const id = providerIdForTile(providerId);
    return id === null ? [] : [id];
  });
  const segmentOrder = mergeOrder(savedOrder, canonical);
  return {
    id: "statusBar.providers",
    label: "Providers",
    kind: "multi",
    touches: ["statusBar"],
    analytics: "layout.statusBar.rateLimits.provider",
    values: segmentOrder.filter(
      (id) => !rateLimits.hiddenProviders.includes(id),
    ),
    options: segmentOrder.map((id) => ({
      value: id,
      label: providerDisplayName(id),
      picture: null,
      override: {},
    })),
    lastItemHeld: false,
    change: (values) => {
      const changed = segmentOrder.find(
        (id) => values.includes(id) === rateLimits.hiddenProviders.includes(id),
      );
      if (changed !== undefined)
        useLayoutStore.getState().toggleStatusBarProvider(changed);
    },
    moveItem: (value, direction) => {
      const providerId = providerIdForTile(value);
      if (providerId === null) return null;
      const next = moveTileId(segmentOrder, providerId, direction);
      if (next === null) return null;
      return {
        id: "provider-order",
        label: "Reorder providers",
        announcement: `${providerDisplayName(providerId)} moved`,
        disabled: false,
        touches: ["statusBar"],
        analytics: "layout.statusBar.segmentOrder",
        run: () =>
          useLayoutStore
            .getState()
            .setStatusBarSegmentOrder(typedProviderOrder(next)),
      };
    },
  };
}
