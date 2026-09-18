import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  searchCustomizeSettings,
  type CustomizeSetting,
} from "@/lib/customize/catalog";
import {
  ensureSampleWorkspaceTab,
  exitCustomize,
} from "@/lib/customize/enter-exit";
import { findCustomizeProxy } from "@/lib/customize/focus";
import {
  ALL_LAYOUT_SLICES,
  recordSettingGesture,
} from "@/lib/customize/history";
import {
  applyLayoutPreset,
  LAYOUT_PRESET_IDS,
  LAYOUT_PRESET_LABELS,
  type LayoutPresetId,
} from "@/lib/layout-presets";
import {
  activateTabIntent,
  existingEpicTabIntentWithNestedFocus,
  type TabNavigationIntent,
} from "@/lib/tab-navigation";
import { cn } from "@/lib/utils";
import {
  selectedInstances,
  useCustomizeStore,
} from "@/stores/customize/customize-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

type Result =
  | { kind: "setting"; setting: CustomizeSetting }
  | { kind: "preset"; preset: LayoutPresetId };
export function CustomizeSearch({
  unreachable,
}: {
  unreachable: ReadonlySet<string>;
}) {
  const id = useId();
  const search = useCustomizeStore((state) => state.search);
  const instances = useCustomizeStore((state) => state.instances);
  const preferredTileId = useCustomizeStore((state) => state.preferredTileId);
  const reported = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const padding = useSafeAreaCollisionPadding();
  const [placement, setPlacement] = useState({ above: false, maxHeight: 0 });
  const resultsOpen = search.query.length > 0;
  useLayoutEffect(() => {
    if (!resultsOpen) return;
    const input = inputRef.current;
    if (!input) return;
    const measure = () => {
      const rect = input.getBoundingClientRect();
      const below = Math.max(
        0,
        window.innerHeight - padding.bottom - rect.bottom,
      );
      const above = Math.max(0, rect.top - padding.top);
      const flip = below < window.innerHeight / 2 && above > below;
      const maxHeight = Math.min(window.innerHeight / 2, flip ? above : below);
      setPlacement((current) =>
        current.above === flip && current.maxHeight === maxHeight
          ? current
          : { above: flip, maxHeight },
      );
    };
    measure();
    const bar = input.closest("[data-customize-bar]");
    const resize = new ResizeObserver(measure);
    resize.observe(input);
    if (bar) resize.observe(bar);
    // Handle dragging and keyboard corner moves, which change position without resizing.
    const move = new MutationObserver(measure);
    if (bar)
      move.observe(bar, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      resize.disconnect();
      move.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [resultsOpen, padding]);
  const navigate = useNavigate();
  const results = useMemo<ReadonlyArray<Result>>(
    () => [
      ...searchCustomizeSettings(search.query).map((setting): Result => ({
        kind: "setting",
        setting,
      })),
      ...LAYOUT_PRESET_IDS.filter((preset) =>
        `${preset} preset`.includes(search.query.toLowerCase().trim()),
      ).map((preset): Result => ({ kind: "preset", preset })),
    ],
    [search.query],
  );
  const selected = selectedInstances({ instances, preferredTileId });
  const resolve = (setting: CustomizeSetting) =>
    selected.find(
      (instance) =>
        instance.settingId === setting.id && !unreachable.has(instance.key),
    );
  const highlight = (index: number) => {
    useCustomizeStore.getState().setSearch(search.query, index);
    const result = results[index];
    const instance =
      result.kind === "setting" ? resolve(result.setting) : undefined;
    useCustomizeStore.getState().setActive(instance?.key ?? null);
    if (instance) {
      instance.node.scrollIntoView({ block: "nearest", behavior: "instant" });
      findCustomizeProxy(instance.key)?.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      });
    }
  };
  const chatTab = useEpicCanvasStore(
    (state) =>
      state.openTabOrder.find((tabId) =>
        Object.values(state.canvasByTabId[tabId]?.tilesByInstanceId ?? {}).some(
          (tile) => tile?.type === "chat",
        ),
      ) ?? null,
  );
  const open = (result: Result) => {
    if (result.kind === "preset") {
      recordSettingGesture(
        `layout.preset.${result.preset}`,
        `${LAYOUT_PRESET_LABELS[result.preset]} preset`,
        ALL_LAYOUT_SLICES,
        () => applyLayoutPreset(result.preset),
      );
      return;
    }
    const instance = resolve(result.setting);
    if (instance) {
      useCustomizeStore
        .getState()
        .openPopover(instance.key, "search", search.query);
      return;
    }
    const intent = chatTab ? openChatIntent(chatTab) : null;
    if (intent) {
      exitCustomize("tab-switch");
      activateTabIntent(navigate, intent, undefined);
    } else ensureSampleWorkspaceTab();
  };
  return (
    <div className="relative min-w-0 flex-1 basis-1/4">
      <Input
        ref={inputRef}
        data-customize-search
        role="combobox"
        aria-label="Search layout settings"
        placeholder="Search layout settings"
        aria-expanded={search.query.length > 0}
        aria-controls={`${id}-results`}
        aria-autocomplete="list"
        aria-activedescendant={
          search.activeIndex >= 0 && results[search.activeIndex]
            ? `${id}-${search.activeIndex}`
            : undefined
        }
        value={search.query}
        onChange={(event) => {
          useCustomizeStore.getState().setSearch(event.target.value, -1);
          useCustomizeStore.getState().setActive(null);
          if (!reported.current && event.target.value) {
            reported.current = true;
            Analytics.getInstance().track(
              AnalyticsEvent.LayoutEditorSearchUsed,
              null,
            );
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (results.length) {
              let index =
                (search.activeIndex +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  results.length) %
                results.length;
              if (search.activeIndex < 0)
                index = event.key === "ArrowDown" ? 0 : results.length - 1;
              highlight(index);
            }
          }
          if (event.key === "Enter") {
            const result = results[Math.max(0, search.activeIndex)];
            if (results.length) {
              event.preventDefault();
              open(result);
            }
          }
        }}
      />
      {search.query ? (
        <div
          data-customize-editor
          className={cn(
            "pointer-events-auto absolute z-50 w-full overflow-y-auto rounded-lg border bg-popover p-2 text-popover-foreground shadow-md",
            placement.above ? "bottom-full" : "top-full",
          )}
          style={{ maxHeight: placement.maxHeight }}
        >
          <div id={`${id}-results`} role="listbox" aria-label="Layout settings">
            {results.map((result, index) => {
              const instance =
                result.kind === "setting" ? resolve(result.setting) : null;
              const label =
                result.kind === "setting"
                  ? result.setting.label
                  : `${LAYOUT_PRESET_LABELS[result.preset]} preset`;
              return (
                <button
                  type="button"
                  tabIndex={-1}
                  key={
                    result.kind === "setting"
                      ? result.setting.id
                      : result.preset
                  }
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={index === search.activeIndex}
                  className={cn(
                    "w-full cursor-pointer rounded-md p-2 text-left text-ui-sm",
                    index === search.activeIndex && "bg-foreground/8",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    highlight(index);
                    open(result);
                  }}
                >
                  <span className="block font-medium">{label}</span>
                  {result.kind === "setting" ? (
                    <span className="block text-ui-xs text-muted-foreground">
                      {result.setting.absent.where} ·{" "}
                      {resultState(instance, chatTab)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {!results.length ? (
            <div className="text-ui-sm">
              No settings match ‘{search.query}’
              <Button
                variant="ghost"
                size="sm"
                onClick={() => useCustomizeStore.getState().setSearch("", -1)}
              >
                Clear
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function resultState(
  instance: { readonly ghost: boolean } | undefined | null,
  chatTab: string | null,
): string {
  if (instance) return instance.ghost ? "hidden" : "visible";
  return chatTab ? "Open chat" : "Open sample workspace";
}

function openChatIntent(tabId: string): TabNavigationIntent | null {
  const state = useEpicCanvasStore.getState();
  const tab = state.tabsById[tabId];
  const canvas = state.canvasByTabId[tabId];
  if (!tab || !canvas?.root) return null;
  const tile = Object.values(canvas.tilesByInstanceId).find(
    (item) => item?.type === "chat",
  );
  if (!tile) return null;
  const pane = collectPanes(canvas.root).find((item) =>
    item.tabInstanceIds.includes(tile.instanceId),
  );
  if (!pane) return null;
  return existingEpicTabIntentWithNestedFocus({
    tabId,
    epicId: tab.epicId,
    focus: undefined,
    nestedFocus: { paneId: pane.id, tileInstanceId: tile.instanceId },
  });
}
