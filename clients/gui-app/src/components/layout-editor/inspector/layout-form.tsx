import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { ChevronRight, LayoutTemplate } from "lucide-react";
import { InspectorBackRow } from "@/components/layout-editor/inspector/inspector-back-row";
import {
  PresetsBlock,
  ResetLayoutButton,
} from "@/components/layout-editor/inspector/presets-block";
import { RegionFilter } from "@/components/layout-editor/inspector/region-filter";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
import { useLayoutFormContext } from "@/components/layout-editor/inspector/use-layout-form-context";
import {
  layoutFindResults,
  type LayoutFindResult,
} from "@/components/layout-editor/regions/region-filter-match";
import { HighlightedText } from "@/components/epic-canvas/git-diff/highlighted-text";
import { layoutRegionRowSelector } from "@/components/layout-editor/layout-search.definitions";
import {
  layoutAreaChanged,
  layoutAreaSummary,
  SURFACE_AREAS,
  type LayoutArea,
  type LayoutAreaId,
} from "@/components/layout-editor/inspector/layout-areas";
import { LAYOUT_REGION_LIST } from "@/components/layout-editor/regions/region-facts";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";
import {
  useLayoutEditorStore,
  type LayoutSettingId,
} from "@/stores/layout/layout-editor-store";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { useLayoutSnapshot } from "@/stores/layout/layout-store";

/**
 * The layout form's two levels (L-06/08/09, partly overturned): All settings -
 * the Presets block and the areas - and one area's form, whose rows disclose
 * their details in place. Settings > Layout and the editor inspector draw the
 * same areas with the same `SurfaceSection`; only the navigation around it is
 * each host's (a master-detail rail on the page, a back row in the dock).
 */

/**
 * The editor inspector's top level: the Presets block, Find, the areas, and
 * `Reset layout…`. A query swaps the areas for the settings it matches.
 */
export function LayoutAllSettings(): ReactNode {
  const snapshot = useLayoutSnapshot();
  const filter = useLayoutEditorStore((state) => state.filter);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const finding = filter.trim().length > 0;
  const { facts } = useLayoutFormContext();
  const results = layoutFindResults(filter, snapshot, facts);

  const openArea = (area: LayoutAreaId): void => {
    if (area !== "presets")
      useLayoutEditorStore.getState().openArea(area, null);
  };
  // A region result opens its area with the row expanded and selected; an
  // area's own row (Placement, Side) has no selection, so focus lands on it
  // once the area has drawn. Opening an area consumes the query (`openArea`).
  const openResult = (result: LayoutFindResult): void => {
    const scope = rootRef.current?.parentElement ?? null;
    useLayoutEditorStore.getState().openArea(result.area, result.region);
    const anchor = result.anchor;
    if (anchor === null || scope === null) return;
    requestAnimationFrame(() => {
      const row = scope.querySelector<HTMLElement>(
        `[data-settings-anchor="${anchor}"]`,
      );
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector<HTMLElement>("button:not(:disabled), input")?.focus();
    });
  };

  function rows(): ReadonlyArray<HTMLButtonElement> {
    return [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-layout-area], [data-layout-find-result]",
      ) ?? []),
    ];
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const all = rows();
    const index = all.findIndex((row) => row === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && index === 0) {
      filterRef.current?.focus();
      return;
    }
    all[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  }

  return (
    <div ref={rootRef} className="flex flex-col">
      <h3 className="px-3.5 pt-3 text-ui-xs font-medium text-muted-foreground">
        Presets
      </h3>
      <PresetsBlock reveal={showAllSettings} />
      <div className="border-t border-border/40">
        <RegionFilter
          ref={filterRef}
          onArrowDown={() => {
            rows().at(0)?.focus();
          }}
          onEnter={() => {
            const first = results.at(0);
            if (first !== undefined) openResult(first);
          }}
        />
      </div>
      {finding && results.length === 0 ? (
        <p
          aria-live="polite"
          className="px-3.5 pt-1 pb-2 text-ui-sm text-muted-foreground"
        >
          No layout settings match "{filter.trim()}".
        </p>
      ) : (
        <>
          <h3
            aria-live="polite"
            className="px-3.5 pt-1 pb-1.5 text-ui-xs font-medium text-muted-foreground"
          >
            {finding
              ? `${String(results.length)} ${results.length === 1 ? "setting" : "settings"}`
              : "All settings"}
          </h3>
          {/* Delegates the rows' arrow keys; the rows are the controls. */}
          <div role="presentation" ref={listRef} onKeyDown={handleRowKeyDown}>
            {finding ? (
              <LayoutFindResultList results={results} onOpen={openResult} />
            ) : (
              <LayoutAreaList
                areas={SURFACE_AREAS}
                snapshot={snapshot}
                onOpen={openArea}
              />
            )}
          </div>
        </>
      )}
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/40 px-3.5 py-3">
        <span className="text-ui-xs text-muted-foreground">
          Changes apply right away.
        </span>
        <ResetLayoutButton />
      </div>
    </div>
  );
}

/**
 * Find's results: a matching area first, then each setting with its area as a
 * breadcrumb and the option or state the query matched, match highlighted.
 */
function LayoutFindResultList(props: {
  readonly results: ReadonlyArray<LayoutFindResult>;
  readonly onOpen: (result: LayoutFindResult) => void;
}): ReactNode {
  return (
    <ul aria-label="Matching settings" className="flex flex-col">
      {props.results.map((result) => {
        const area = SURFACE_AREAS.find((entry) => entry.id === result.area);
        const Icon = area?.icon ?? LayoutTemplate;
        return (
          <li key={result.key}>
            <button
              type="button"
              data-layout-find-result={result.key}
              className="flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none"
              onClick={() => {
                props.onOpen(result);
              }}
            >
              <Icon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui-sm">
                  <HighlightedText
                    text={result.label}
                    ranges={
                      result.labelMatch === null ? [] : [result.labelMatch]
                    }
                  />
                </span>
                <span className="flex min-w-0 items-center gap-1 text-ui-xs text-muted-foreground">
                  <span className="shrink-0">
                    {result.kind === "area" ? "Area" : area?.label}
                  </span>
                  {result.detail === null ? null : (
                    <>
                      <ChevronRight aria-hidden className="size-3 shrink-0" />
                      <span className="truncate">
                        <HighlightedText
                          text={result.detail.text}
                          ranges={
                            result.detail.match === null
                              ? []
                              : [result.detail.match]
                          }
                        />
                      </span>
                    </>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The areas as rows that open them: icon, name, changed dot, state summary and
 * a chevron.
 */
function LayoutAreaList(props: {
  readonly areas: ReadonlyArray<LayoutArea>;
  readonly snapshot: LayoutSnapshot;
  readonly onOpen: (area: LayoutAreaId) => void;
}): ReactNode {
  const { areas, snapshot, onOpen } = props;
  return (
    <ul aria-label="All settings" className="flex flex-col">
      {areas.map((area) => {
        const changed = layoutAreaChanged(area.id, snapshot);
        return (
          <li key={area.id}>
            <button
              type="button"
              data-layout-area={area.id}
              className="flex h-9 w-full items-center gap-2.5 px-3.5 text-left text-ui-sm hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none"
              onClick={() => {
                onOpen(area.id);
              }}
            >
              <area.icon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{area.label}</span>
              {changed ? (
                <>
                  <span
                    aria-hidden
                    data-testid="area-changed-dot"
                    className="size-1.5 shrink-0 rounded-full bg-info"
                  />
                  <span className="sr-only">, changed</span>
                </>
              ) : null}
              <span className="min-w-16 shrink-0 truncate text-right text-ui-xs text-muted-foreground">
                {layoutAreaSummary(area.id, snapshot)}
              </span>
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The editor inspector's second level: the way back, then the area's form.
 * The canvas's selected region is the highlighted row, scrolled into view.
 */
export function LayoutAreaLevel(props: {
  readonly area: SurfaceGroupId;
}): ReactNode {
  const { area } = props;
  const surface = SURFACE_AREAS.find((entry) => entry.id === area);
  const snapshot = useLayoutSnapshot();
  const openRows = useLayoutEditorStore((state) => state.openRows);
  const selected = useLayoutEditorStore((state) => state.selected);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selected === null) return;
    rootRef.current
      ?.querySelector(layoutRegionRowSelector(selected))
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, area]);

  return (
    <div
      ref={rootRef}
      onPointerOver={hoverRowUnder}
      onPointerLeave={() => {
        useLayoutEditorStore.getState().setHovered(null);
        useLayoutEditorStore.getState().setHoveredSetting(null);
      }}
      onPointerDownCapture={selectSettingRowUnder}
      onFocusCapture={selectSettingRowUnder}
    >
      <InspectorBackRow label="All settings" onBack={showAllSettings} />
      <div className="px-3.5 pt-3 pb-2">
        <h3 className="text-ui-sm font-medium">{surface?.label}</h3>
        <p className="mt-0.5 text-ui-xs text-muted-foreground">
          {surface?.description}
        </p>
      </div>
      <div className="border-t border-border/40">
        <SurfaceSection
          surface={area}
          snapshot={snapshot}
          openRows={openRows}
          onToggleRow={toggleRow}
          onSelectRow={toggleSelected}
          selectedRow={selected}
        />
      </div>
    </div>
  );
}

/**
 * Hovering a region's row lights it on the canvas, and materialises it there
 * while it is hidden (L-14) - the same `hovered` a canvas hover sets.
 */
function hoverRowUnder(event: PointerEvent<HTMLDivElement>): void {
  if (!(event.target instanceof Element)) return;
  const owner = event.target.closest(
    "[data-sortable-id], [data-region-section]",
  );
  const id =
    owner?.getAttribute("data-sortable-id") ??
    owner?.getAttribute("data-region-section");
  const region = LAYOUT_REGION_LIST.find((entry) => entry.id === id);
  const store = useLayoutEditorStore.getState();
  store.setHovered(region?.id ?? null);
  store.setHoveredSetting(settingRowOf(event.target));
}

/**
 * A press or a focus inside a setting's row selects it, which rings its part
 * on the canvas - the row has no disclosure to open as a region's row does.
 */
function selectSettingRowUnder(event: SyntheticEvent<HTMLDivElement>): void {
  if (!(event.target instanceof Element)) return;
  const setting = settingRowOf(event.target);
  if (setting !== null) useLayoutEditorStore.getState().selectSetting(setting);
}

/** The setting whose row holds `target`, by the row's Settings-search anchor. */
function settingRowOf(target: Element): LayoutSettingId | null {
  const anchor = target
    .closest("[data-settings-anchor]")
    ?.getAttribute("data-settings-anchor");
  return anchor === LAYOUT.definitions.sideStripView.anchor
    ? "sideStripView"
    : null;
}

function showAllSettings(): void {
  useLayoutEditorStore.getState().openArea(null, null);
}

function toggleRow(rowId: string): void {
  useLayoutEditorStore.getState().toggleRow(rowId);
}

/** A row with no disclosure selects its region, and a second press clears it. */
function toggleSelected(regionId: RegionId): void {
  const store = useLayoutEditorStore.getState();
  // Selecting opens the row (`openArea`), so clearing closes it too through
  // `toggleRow`; a leftover open id would cost Escape a press that shows nothing.
  if (store.selected === regionId) store.toggleRow(regionId);
  else store.select(regionId);
}
