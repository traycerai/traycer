import { LayoutUsageProvider } from "@/components/layout-editor/inspector/provider-limit-windows";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Tabs as TabsPrimitive } from "radix-ui";
import { focusSortableRowGrab } from "@/components/layout-editor/inspector/first-row-focus";
import {
  LAYOUT_AREAS,
  layoutAreaChanged,
  type LayoutAreaId,
} from "@/components/layout-editor/inspector/layout-areas";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import {
  PresetsBlock,
  ResetLayoutButton,
} from "@/components/layout-editor/inspector/presets-block";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
import { layoutRegionRowSelector } from "@/components/layout-editor/layout-search.definitions";
import { SURFACE_GROUPS } from "@/components/layout-editor/regions/region-grammar";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { SettingsGroup } from "@/components/settings/settings-group";
import {
  SettingsDetailHeader,
  SettingsMasterDetail,
  SettingsMasterSelect,
} from "@/components/settings/settings-master-detail";
import {
  SETTINGS_AREA_BODY_PROPS,
  useSettingsAnchorArea,
  useSettingsAreaStartsAtTop,
} from "@/components/settings/settings-master-detail-area";
import { settingsRailRowClassName } from "@/components/settings/settings-rail-row";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { scrollPaneToCenter } from "@/components/settings/use-settings-anchor-reveal";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { Button } from "@/components/ui/button";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { LAYOUT_EDITOR_HELD_ELSEWHERE_REASON } from "@/lib/layout/editor-lease";
import { useLayoutEditorFitsWindow } from "@/lib/layout/editor-width";
import { openLayoutEditor } from "@/lib/layout/editor-session";
import { useLayoutEditorDoor } from "@/lib/layout/use-layout-editor-door";
import { activateTabIntent } from "@/lib/tab-navigation";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import {
  readPendingLayoutLanding,
  subscribePendingLayoutLanding,
  takePendingLayoutLanding,
} from "@/lib/settings-navigation";
import { useLayoutSnapshot } from "@/stores/layout/layout-store";

/**
 * The full-width host for the layout form (L-03): one area at a time, in
 * Settings ▸ Providers' master-detail layout (H2).
 *
 * Not a second form: the areas, the Presets block and each area's rows are the
 * ones the editor inspector draws (`inspector/layout-form.tsx`). What differs
 * is the navigation around them: this page lists the areas in a rail and draws
 * the one picked beside it, where the inspector opens an area from its All
 * settings level with a back row.
 *
 * The areas are a vertical tab list, so the arrow keys walk them. Every area
 * stays mounted, hidden while another is picked (`forceMount` makes Radix drop
 * its own `hidden`, so it is passed here): Radix mounts a picked area's
 * children a commit AFTER the pick (Presence flips in a layout effect), so a
 * region landing or a search reveal that switches area would look for its row
 * in an empty pane and have nothing to re-run it. Settings search lands on
 * every row here, and picks its area first (`useSettingsAnchorArea`,
 * `useLayoutRegionLanding`).
 */
export function LayoutSettingsPanel(): ReactNode {
  const isMobile = useIsMobileViewport();
  const snapshot = useLayoutSnapshot();
  const [area, setArea] = useState<LayoutAreaId>("presets");
  const [openRows, setOpenRows] = useState<ReadonlyArray<string>>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const toggleRow = useCallback((rowId: string): void => {
    setOpenRows((current) =>
      current.includes(rowId)
        ? current.filter((entry) => entry !== rowId)
        : [...current, rowId],
    );
  }, []);

  useSettingsAnchorArea("layout", layoutAreaForAnchor, setArea);
  useLayoutRegionLanding({
    paneRef: rootRef,
    tab: area,
    setTab: setArea,
    openRows,
    setOpenRows,
  });
  useSettingsAreaStartsAtTop(rootRef, area);

  const changed = (id: LayoutAreaId): boolean =>
    layoutAreaChanged(id, snapshot);

  return (
    <SettingsPanelShell
      title="Layout"
      // Desktop only, as on Providers: on a phone the description's own width
      // wraps the action onto a row of its own (see the Providers panel).
      description={isMobile ? undefined : LAYOUT.page.description}
      headerAction={<OpenEditorAction area={area} />}
      // Desktop only, as on Providers: the card fills the settings pane and the
      // picked area's body owns the scroll. A phone has one scroll container
      // already, so there the card is sized by its contents.
      fillHeight={!isMobile}
    >
      {/* Every row below reads its density and its "where does a deeper level
        open" from here, once, rather than from a prop threaded through each
        list (P-4, L-89). */}
      <LayoutUsageProvider>
        <LayoutFormHostContext value="page">
          <TabsPrimitive.Root
            ref={rootRef}
            value={area}
            onValueChange={(value) => {
              const next = LAYOUT_AREAS.find((entry) => entry.id === value);
              if (next !== undefined) setArea(next.id);
            }}
            orientation="vertical"
            // The setup guide's "Every piece has a row" target: the areas and
            // the picked one together, on a phone as on a desktop.
            data-layout-areas
            className="flex flex-col md:h-full md:min-h-0"
          >
            <SettingsMasterDetail
              railLabel="Layout areas"
              mobileSelect={
                <SettingsMasterSelect
                  label="Layout area"
                  value={area}
                  options={LAYOUT_AREAS.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                    icon: <entry.icon className="size-4 shrink-0" />,
                    trailing: changed(entry.id) ? <ChangedDot /> : null,
                  }))}
                  onSelect={setArea}
                />
              }
              rail={
                <TabsPrimitive.List
                  aria-label="Layout areas"
                  // Shrinks and scrolls in a short pane, as Providers' list does,
                  // so the last areas are never clipped by the card.
                  className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
                >
                  {LAYOUT_AREAS.map((entry) => (
                    <TabsPrimitive.Trigger
                      key={entry.id}
                      value={entry.id}
                      className={settingsRailRowClassName(area === entry.id)}
                    >
                      <entry.icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {entry.label}
                      </span>
                      {changed(entry.id) ? <ChangedDot /> : null}
                    </TabsPrimitive.Trigger>
                  ))}
                </TabsPrimitive.List>
              }
            >
              {LAYOUT_AREAS.map((entry) => (
                <TabsPrimitive.Content
                  key={entry.id}
                  value={entry.id}
                  forceMount
                  hidden={area !== entry.id}
                  // Named by its area rather than by the rail's trigger, which a
                  // phone does not draw.
                  aria-labelledby={undefined}
                  aria-label={entry.label}
                  className="flex flex-1 flex-col outline-none md:min-h-0"
                >
                  <div className="border-b border-border/60 pb-4">
                    <SettingsDetailHeader
                      title={entry.label}
                      badge={null}
                      description={entry.description}
                      footer={null}
                      action={null}
                    />
                  </div>
                  {/* From `md` up the scroll owner, so the rail and the area's
                  header stay put: nothing passes UNDER them, so neither needs
                  an opaque fill over the card's translucent surface. */}
                  <div
                    data-layout-area-body
                    {...SETTINGS_AREA_BODY_PROPS}
                    className="-mx-5 flex flex-col gap-4 px-5 pt-4 pb-5 md:min-h-0 md:flex-1 md:overflow-y-auto"
                  >
                    <LayoutAreaBody
                      area={entry.id}
                      snapshot={snapshot}
                      openRows={openRows}
                      onToggleRow={toggleRow}
                      onShowPresets={() => {
                        setArea("presets");
                      }}
                    />
                  </div>
                </TabsPrimitive.Content>
              ))}
            </SettingsMasterDetail>
          </TabsPrimitive.Root>
        </LayoutFormHostContext>
      </LayoutUsageProvider>
    </SettingsPanelShell>
  );
}

/** One area's card: the Presets block and Reset layout, or a surface's form. */
function LayoutAreaBody(props: {
  readonly area: LayoutAreaId;
  readonly snapshot: LayoutSnapshot;
  readonly openRows: ReadonlyArray<string>;
  readonly onToggleRow: (rowId: string) => void;
  readonly onShowPresets: () => void;
}): ReactNode {
  const { area, snapshot } = props;
  if (area === "presets") {
    return (
      <>
        <SettingsGroup
          group={LAYOUT.definitions.presets}
          showTitle={false}
          tone="default"
          dataTestId="layout-presets-group"
          fill={false}
        >
          <PresetsBlock reveal={props.onShowPresets} />
        </SettingsGroup>
        <SettingsGroup
          group={LAYOUT.definitions.resetLayout}
          showTitle={false}
          tone="danger"
          dataTestId="layout-reset-group"
          fill={false}
        >
          <SettingsRow
            row={LAYOUT.definitions.resetLayoutAction}
            control={<ResetLayoutButton />}
          />
        </SettingsGroup>
      </>
    );
  }
  return (
    <SettingsGroup
      group={LAYOUT.definitions[area]}
      showTitle={false}
      tone="default"
      dataTestId={`layout-surface-${area}`}
      fill={false}
    >
      <SurfaceSection
        surface={area}
        snapshot={snapshot}
        openRows={props.openRows}
        onToggleRow={props.onToggleRow}
        onSelectRow={null}
        selectedRow={null}
      />
    </SettingsGroup>
  );
}

/** Which area holds each settings-definition group; anything else is on no area. */
const AREA_FOR_GROUP: Readonly<Record<string, LayoutAreaId>> = {
  presets: "presets",
  resetLayout: "presets",
  ...Object.fromEntries(SURFACE_GROUPS.map((group) => [group.id, group.id])),
};

/**
 * The area a settings-search anchor lives in, or `null` for one that is on no
 * area (the header's editor button) or not this page's.
 */
function layoutAreaForAnchor(anchor: string): LayoutAreaId | null {
  const definition = Object.values(LAYOUT.definitions).find(
    (entry) => entry.anchor === anchor,
  );
  if (definition === undefined) return null;
  const groupKey =
    definition.kind === "row" ? definition.group : definition.key;
  return groupKey === null ? null : (AREA_FOR_GROUP[groupKey] ?? null);
}

/** The same dot a changed row draws, said in words for a screen reader. */
function ChangedDot(): ReactNode {
  return (
    <>
      <span
        aria-hidden
        data-testid="area-changed-dot"
        className="size-1.5 shrink-0 rounded-full bg-info"
      />
      <span className="sr-only">, changed</span>
    </>
  );
}

/**
 * The way from this page into the canvas editor (5.1), and the only entry in
 * Settings: the page header's action, where Providers keeps its refresh (H2).
 *
 * It lives HERE rather than on Appearance because this page is the editor's own
 * other half: the same components, drawn full width, and the place the door
 * itself lands when the window is too narrow for a canvas (L-03, L-64).
 * Below that threshold the button is withheld rather than disabled - pressing
 * it would navigate to the page the user is already reading - and says so in
 * its place, because it is still the guide's final coachmark target (L-50)
 * and the search result "Customize layout" lands on it.
 *
 * In the installed app it is nothing at all: no window there is ever wide
 * enough, so "needs a wider window" names a remedy that does not exist. The
 * search result and the guide's step are withheld by the same predicate.
 * While another window holds the editor it is disabled and says so under
 * itself, through the same door every other entry reads (T6).
 */
function OpenEditorAction(props: { readonly area: LayoutAreaId }): ReactNode {
  const navigate = useNavigate();
  const fits = useLayoutEditorFitsWindow();
  const door = useLayoutEditorDoor();
  const reasonId = useId();
  if (door === "absent") return null;
  const heldElsewhere = door === "held-elsewhere";
  return (
    <div
      data-settings-anchor={LAYOUT.definitions.customizeEntry.anchor}
      className="flex flex-col items-end gap-1"
    >
      {fits ? (
        <Button
          type="button"
          size="sm"
          // Another window holds the editor (T6): the door says so in place,
          // in the palette's words, rather than taking a press it cannot act on.
          disabled={heldElsewhere}
          aria-describedby={heldElsewhere ? reasonId : undefined}
          onClick={() => {
            openLayoutEditor({
              source: "direct_ui",
              entry: "pointer",
              target: null,
              origin: {
                kind: "settings",
                area: props.area === "presets" ? null : props.area,
              },
              navigateToTabIntent: (intent) =>
                activateTabIntent(navigate, intent, undefined),
            });
          }}
        >
          Customize layout
        </Button>
      ) : (
        // The button's own height, so the line sits where the button would.
        <p className="flex h-7 items-center text-ui-sm text-muted-foreground">
          The editor needs a wider window
        </p>
      )}
      {fits && heldElsewhere ? (
        <p id={reasonId} className="text-ui-xs text-muted-foreground">
          {LAYOUT_EDITOR_HELD_ELSEWHERE_REASON}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Landing on a region row (A.5 gap 1), or on an area.
 *
 * Below the editor's width threshold the door redirects here instead of
 * opening a canvas, and until now it discarded the region the user had asked
 * for: a search result for "Minimap" in a 900px window landed on a page with
 * nothing preselected, nothing scrolled to and nothing highlighted. The door
 * now hands the region over (`navigateToLayoutRegion`), and this is the page
 * taking it: scroll the row into the middle of the pane, open its disclosure,
 * and mark it with the same flash every other settings result leaves.
 *
 * The request OUTLIVES the call that made it, because the panel mounts after
 * the navigation commits - so it is read from the door's own slot rather than
 * passed in, and taking it is what ends it.
 *
 * **The request survives the renders that make the row exist** (5.9). Two
 * writes can be what puts the row on the page - picking its surface's area
 * (H2), and opening the row's own disclosure - and both of them re-render,
 * so the row does not exist until React has committed them.
 * The effect therefore makes those writes and RETURNS, leaving the request in
 * its slot; it runs again in the commit they produce, where the page is in the
 * state the row needs and the DOM is laid out. Nothing is deferred to a timer:
 * re-running on the commit is React's own guarantee, not a guess about when
 * one will happen. Taking the request is what ends it, and it is taken on the
 * pass that could answer it whether or not a row was there to answer with - a
 * landing that fired later, on an unrelated keystroke, would be a scroll
 * nobody asked for.
 */
function useLayoutRegionLanding(input: {
  readonly paneRef: { current: HTMLDivElement | null };
  readonly tab: LayoutAreaId;
  readonly setTab: (tab: LayoutAreaId) => void;
  readonly openRows: ReadonlyArray<string>;
  readonly setOpenRows: (
    update: (current: ReadonlyArray<string>) => string[],
  ) => void;
}): void {
  const { paneRef, tab, setTab, openRows, setOpenRows } = input;
  const pending = useSyncExternalStore(
    subscribePendingLayoutLanding,
    readPendingLayoutLanding,
    readPendingLayoutLanding,
  );

  useEffect(() => {
    if (pending === null) return;
    // An area landing (the editor's Done, back to where it was opened from)
    // is only the pick.
    if (pending.target.kind === "area") {
      takePendingLayoutLanding();
      setTab(pending.target.area ?? "presets");
      return;
    }
    const regionId = pending.target.regionId;
    const surface = LAYOUT_REGIONS[regionId].surface;
    const elsewhere = tab !== surface;
    const closed = !openRows.includes(regionId);
    if (elsewhere) setTab(surface);
    if (closed) setOpenRows((current) => [...current, regionId]);
    if (elsewhere || closed) return;
    takePendingLayoutLanding();
    const region =
      paneRef.current?.querySelector(layoutRegionRowSelector(regionId)) ?? null;
    // A row inside the region's own section (a provider in the Profiles list)
    // when that is the controller a reason names. A row the list does not
    // draw (a provider the usage readings no longer list) falls back to the
    // region's own row, so the link still lands somewhere.
    const inner =
      pending.target.kind === "region-row"
        ? (region?.querySelector(
            `[data-sortable-id="${pending.target.row}"]`,
          ) ?? null)
        : null;
    const row = inner ?? region;
    if (row === null) return;
    scrollPaneToCenter(row, null);
    // The scroll is for the eye; the focus is for the hands. A keyboard user
    // used to land with focus wherever navigation had left it, looking at a
    // flash they could not act on.
    focusSortableRowGrab(row);
    row.setAttribute(LANDING_FLASH_ATTRIBUTE, "true");
    window.setTimeout(() => {
      row.removeAttribute(LANDING_FLASH_ATTRIBUTE);
    }, LANDING_FLASH_MS);
  }, [pending, tab, setTab, openRows, paneRef, setOpenRows]);
}

/** The same mark every settings-search result leaves (`settings-search.css`). */
const LANDING_FLASH_ATTRIBUTE = "data-settings-anchor-flash";
const LANDING_FLASH_MS = 1800;
