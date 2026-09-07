/** Dev-only canvas fixture seeder. Composes tile refs directly because affordance-level routes cap insert-on-repeat. Entry is a dynamic `import()` inside `import.meta.env.DEV`; `SEED_FIXTURE_SENTINEL` proves it was eliminated from production. */
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { WORKSPACE_FILE_TAB_KIND } from "@/stores/epics/canvas/types";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicViewTab,
} from "@/stores/epics/canvas/types";
import type { TileLayoutNode } from "@/stores/epics/canvas/tile-tree";

/** Unique string with no other reason to exist. Its presence in a production bundle means dead-code elimination failed and this module shipped. */
export const SEED_FIXTURE_SENTINEL = "__TRAYCER_SEED_FIXTURE_a7f3c19d__";

/** Titles chosen so rendered tab widths reproduce the certified unequal regime. Width tracks title length under `max-w-40`, so these are the knob. */
const WIDE_TITLE = "Seeded Wide Fixture Tile For Regression";
const MID_TITLE = "Seeded Mid T";
const NARROW_TITLE = "Seed";

export interface SeedFixtureSpec {
  /** Tiles in the source group. >= 4 for the overflow case. */
  readonly sourceTiles: number;
  /** Tiles in the destination group. */
  readonly targetTiles: number;
  /** Split into two pane groups. */
  readonly twoGroups: boolean;
  /** Fail unless some strip overflows by >= 2x its widest tile (S1.6). */
  readonly requireAutoScrollOverflow: boolean;
}

export interface SeededPaneReport {
  readonly paneId: string;
  readonly tileIds: readonly string[];
}

/** Overflow as measured numbers, not a boolean: 1px overflow is not enough travel to grade autoScroll. */
export interface StripOverflowReport {
  readonly groupId: string;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly overflow: number;
  readonly widestTile: number;
  /** `overflow >= 2x the widest tile` - enough travel for a sustained drag. */
  readonly sufficientForAutoScroll: boolean;
}

export interface SeedFixtureReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly panes: readonly SeededPaneReport[];
  readonly overflow: readonly StripOverflowReport[];
  readonly fingerprint: string;
}

function seededTitle(index: number): string {
  if (index % 3 === 0) return `${WIDE_TITLE} ${index}`;
  if (index % 3 === 1) return `${MID_TITLE} ${index}`;
  return `${NARROW_TITLE}${index}`;
}

/** Workspace-file refs, not blanks: `parseBlankTileRef` hard-codes `name`, so titles would collapse to uniform width. */
function seededRef(index: number, hostId: string): EpicCanvasTileRef {
  return {
    id: `seed-tile-${index}`,
    instanceId: `seed-inst-${index}`,
    type: WORKSPACE_FILE_TAB_KIND,
    name: seededTitle(index),
    hostId,
    workspacePath: `/seed/fixture`,
    filePath: `/seed/fixture/tile-${index}.txt`,
  };
}

/** Whether every seeded ref survives serialize -> parse. Catches any field a schema hard-codes on parse. */
export interface RoundTripReport {
  readonly ok: boolean;
  readonly drifted: readonly string[];
}

export function checkSeededRoundTrip(tabId: string): RoundTripReport {
  const canvas = readCanvas(tabId);
  const drifted: string[] = [];
  if (canvas === null) return { ok: false, drifted: ["no canvas"] };
  for (const [instanceId, ref] of Object.entries(canvas.tilesByInstanceId)) {
    if (ref === undefined) continue;
    const reparsed = parseTileRef(serializeTileRef(ref));
    if (reparsed === null) {
      drifted.push(`${instanceId.slice(0, 12)}: failed to reparse`);
      continue;
    }
    if (reparsed.name !== ref.name) {
      drifted.push(
        `${instanceId.slice(0, 12)}: name "${ref.name}" -> "${reparsed.name}"`,
      );
    }
  }
  return { ok: drifted.length === 0, drifted };
}

/** Snapshot taken at seed time so teardown restores exactly, not approximately. */
let preSeedSnapshot: EpicCanvasState | null = null;
let seededTabId: string | null = null;

/** Strip scroll is DOM state, not `EpicCanvasState`. Restore it separately or a trial starts mid-strip. */
let preSeedScrollByIndex: readonly number[] = [];

/** Strip scroll offsets left-to-right. Keyed by position: seeding regenerates group ids. */
function readScrollLefts(): readonly number[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="tab-strip"][data-group-id]',
    ),
  ]
    .map((strip) => ({
      x: strip.getBoundingClientRect().left,
      end: strip.querySelector<HTMLElement>('[data-testid="tab-strip-end"]'),
    }))
    .filter(
      (entry): entry is { x: number; end: HTMLElement } => entry.end !== null,
    )
    .sort((a, b) => a.x - b.x)
    .map((entry) => entry.end.scrollLeft);
}

function readOverflow(): readonly StripOverflowReport[] {
  const out: StripOverflowReport[] = [];
  for (const strip of document.querySelectorAll<HTMLElement>(
    '[data-testid="tab-strip"][data-group-id]',
  )) {
    const groupId = strip.dataset.groupId;
    const end = strip.querySelector<HTMLElement>(
      '[data-testid="tab-strip-end"]',
    );
    if (groupId === undefined || end === null) continue;
    const widths = [
      ...strip.querySelectorAll<HTMLElement>("[data-tile-item-id]"),
    ].map((tile) => tile.getBoundingClientRect().width);
    const widestTile = widths.length === 0 ? 0 : Math.max(...widths);
    const overflow = end.scrollWidth - end.clientWidth;
    out.push({
      groupId,
      clientWidth: end.clientWidth,
      scrollWidth: end.scrollWidth,
      overflow,
      widestTile: Number(widestTile.toFixed(1)),
      sufficientForAutoScroll: widestTile > 0 && overflow >= 2 * widestTile,
    });
  }
  return out;
}

function readCanvas(tabId: string): EpicCanvasState | null {
  const store = useEpicCanvasStore.getState();
  return store.canvasByTabId[tabId] ?? null;
}

function paneReports(tabId: string): readonly SeededPaneReport[] {
  const canvas = readCanvas(tabId);
  if (canvas === null || canvas.root === null) return [];
  const out: SeededPaneReport[] = [];
  // `TileGroup` is N-ary (`children`), not binary.
  const walk = (node: TileLayoutNode): void => {
    if (node.kind === "pane") {
      out.push({ paneId: node.id, tileIds: [...node.tabInstanceIds] });
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(canvas.root);
  return out;
}

/** Fingerprint by tile composition, excluding pane ids (fresh uuids on every split). Tile order within a pane is preserved. */
function fingerprintOf(tabId: string): string {
  // Panes in tree order (left-to-right for a horizontal split). Do not sort composition strings.
  return paneReports(tabId)
    .map((pane) => pane.tileIds.map((id) => id.slice(0, 12)).join(","))
    .join(" | ");
}

/** Build the fixture. Returns a report of what was built, not a boolean. */
export function seedCanvasFixture(
  tabId: string,
  spec: SeedFixtureSpec,
  hostId: string,
): SeedFixtureReport {
  const store = useEpicCanvasStore.getState();
  const before = readCanvas(tabId);
  if (before === null) {
    return {
      ok: false,
      failures: [`no canvas for tab ${tabId}`],
      panes: [],
      overflow: [],
      fingerprint: "",
    };
  }
  if (seededTabId !== null && seededTabId !== tabId) {
    return {
      ok: false,
      failures: [
        `fixture already active for tab ${seededTabId}; teardown before seeding ${tabId}`,
      ],
      panes: paneReports(tabId),
      overflow: [],
      fingerprint: fingerprintOf(tabId),
    };
  }
  // Re-seeding the same tab: keep the original pre-seed snapshot. One global snapshot cannot restore two canvases honestly.
  if (seededTabId === null) {
    preSeedSnapshot = before;
    seededTabId = tabId;
    preSeedScrollByIndex = readScrollLefts();
  }

  // Reset to an empty canvas first so the result depends on the spec, not residue. Teardown restores `preSeedSnapshot`.
  useEpicCanvasStore.setState((state) => ({
    ...state,
    canvasByTabId: { ...state.canvasByTabId, [tabId]: createEmptyCanvas() },
  }));

  // First tile via `openTile` (seeds a null root). Later tiles via `openTileInBackgroundTab` (append, never fill-in-place). Split after source tiles exist.
  let opened = 0;
  const openInto = (index: number): void => {
    if (opened === 0 && readCanvas(tabId)?.root === null) {
      store.openTileInTab(tabId, seededRef(index, hostId));
    } else {
      store.openTileInBackgroundTab(tabId, seededRef(index, hostId));
    }
    opened += 1;
  };

  for (let index = 0; index < spec.sourceTiles; index++) openInto(index);

  if (spec.twoGroups) {
    const sourcePanes = paneReports(tabId);
    if (sourcePanes.length > 0) {
      const source = sourcePanes[0];
      store.splitPaneEmptyInTab(tabId, source.paneId, "horizontal");
      // `openTileInBackgroundTab` appends to `activePaneOrFirst`; activate the new pane first.
      const afterSplit = paneReports(tabId);
      const created = afterSplit.find((pane) => pane.tileIds.length === 0);
      if (created !== undefined) {
        store.setActiveTilePane(tabId, created.paneId);
        for (let index = 0; index < spec.targetTiles; index++) {
          store.openTileInBackgroundTab(
            tabId,
            seededRef(spec.sourceTiles + index, hostId),
          );
        }
        store.setActiveTilePane(tabId, source.paneId);
      }
    }
  }

  const panes = paneReports(tabId);
  const failures: string[] = [];
  if (spec.twoGroups && panes.length < 2) {
    failures.push(`wanted 2 panes, built ${panes.length}`);
  }
  const largest = panes.reduce(
    (best, pane) =>
      pane.tileIds.length > (best?.tileIds.length ?? 0) ? pane : best,
    null as SeededPaneReport | null,
  );
  if (largest === null || largest.tileIds.length < spec.sourceTiles) {
    failures.push(
      `wanted a source of ${spec.sourceTiles}, largest holds ${largest?.tileIds.length ?? 0}`,
    );
  }

  // Do not measure overflow here: a DOM read on this tick sees the previous layout.
  const overflow: readonly StripOverflowReport[] = [];

  return {
    ok: failures.length === 0,
    failures,
    panes,
    overflow,
    fingerprint: fingerprintOf(tabId),
  };
}

/** Restore the exact pre-seed canvas. Approximate teardown leaves residue the next measurement inherits. */
export interface TeardownReport {
  readonly ok: boolean;
  readonly fingerprint: string;
  /** Scroll is restored later, after the structural restore has rendered. */
  readonly scrollPending: number;
}

export function teardownCanvasFixture(): TeardownReport {
  const tabId = seededTabId;
  const snapshot = preSeedSnapshot;
  if (tabId === null || snapshot === null) {
    return { ok: false, fingerprint: "", scrollPending: 0 };
  }
  useEpicCanvasStore.setState((state) => ({
    ...state,
    canvasByTabId: { ...state.canvasByTabId, [tabId]: snapshot },
  }));
  const fingerprint = fingerprintOf(tabId);
  preSeedSnapshot = null;
  seededTabId = null;
  return { ok: true, fingerprint, scrollPending: preSeedScrollByIndex.length };
}

export interface ScrollRestoreReport {
  readonly ok: boolean;
  readonly wanted: readonly number[];
  readonly got: readonly number[];
  readonly mismatches: readonly string[];
}

/** Apply captured scroll offsets by position after structural restore. Refuse success when strip count no longer matches. */
export function restoreSeededScroll(): ScrollRestoreReport {
  const wanted = preSeedScrollByIndex;
  const ends = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="tab-strip"][data-group-id]',
    ),
  ]
    .map((strip) => ({
      x: strip.getBoundingClientRect().left,
      end: strip.querySelector<HTMLElement>('[data-testid="tab-strip-end"]'),
    }))
    .filter(
      (entry): entry is { x: number; end: HTMLElement } => entry.end !== null,
    )
    .sort((a, b) => a.x - b.x)
    .map((entry) => entry.end);

  const mismatches: string[] = [];
  if (wanted.length === 0) mismatches.push("nothing captured to restore");
  if (ends.length !== wanted.length) {
    mismatches.push(
      `captured ${wanted.length} strip(s), found ${ends.length} live`,
    );
  }
  // Only the overlapping prefix can be restored; a count difference is already reported above.
  const pairs = Math.min(ends.length, wanted.length);
  for (let index = 0; index < pairs; index++) {
    ends[index].scrollLeft = wanted[index];
  }
  const got = readScrollLefts();
  for (let index = 0; index < Math.min(pairs, got.length); index++) {
    if (Math.abs(got[index] - wanted[index]) > 1) {
      mismatches.push(
        `strip ${index}: wanted ${wanted[index]}, got ${got[index]}`,
      );
    }
  }
  preSeedScrollByIndex = [];
  return { ok: mismatches.length === 0, wanted, got, mismatches };
}

/** Seed header tabs. Header width is count-driven, not title-driven (opposite of the tile strip). */
export interface HeaderSeedReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly seededTabIds: readonly string[];
  /** Tabs present before seeding. `count` is additive; read the achieved total from `measureHeader()` after render. */
  readonly preExisting: number;
}

let preSeedOpenTabOrder: readonly string[] | null = null;

export function seedHeaderTabs(
  count: number,
  epicId: string,
): HeaderSeedReport {
  const store = useEpicCanvasStore.getState();
  // Remember the order without previously seeded tabs, so a repeat cannot memoise a seeded baseline.
  preSeedOpenTabOrder ??= store.openTabOrder.filter(
    (id) => !id.startsWith("seed-header-"),
  );

  const seededTabIds: string[] = [];
  const tabs: Record<string, EpicViewTab | undefined> = { ...store.tabsById };
  const canvases: Record<string, EpicCanvasState> = {};
  for (let index = 0; index < count; index++) {
    const tabId = `seed-header-${index}`;
    seededTabIds.push(tabId);
    tabs[tabId] = {
      tabId,
      epicId,
      // Name does not affect header width.
      name: `Seeded Header ${index}`,
    };
    canvases[tabId] = createEmptyCanvas();
  }

  // Drop prior seeded ids before appending: ids are deterministic, so a second append would duplicate.
  useEpicCanvasStore.setState((state) => ({
    ...state,
    tabsById: tabs,
    canvasByTabId: { ...state.canvasByTabId, ...canvases },
    openTabOrder: [
      ...state.openTabOrder.filter((id) => !id.startsWith("seed-header-")),
      ...seededTabIds,
    ],
  }));

  const failures: string[] = [];
  if (seededTabIds.length !== count) {
    failures.push(`wanted ${count} new, made ${seededTabIds.length}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    seededTabIds,
    preExisting: preSeedOpenTabOrder.length,
  };
}

/** Restore the pre-seed header. Separate from the canvas teardown. */
/** Mint a draft header tab. Drafts are projected from a different store than epic tabs. */
export interface DraftSeedReport {
  readonly ok: boolean;
  readonly draftId: string;
  readonly failures: readonly string[];
}

let seededDraftIds: string[] = [];

export function seedDraftTab(): DraftSeedReport {
  const before = useLandingDraftStore.getState().drafts.length;
  const draftId = useLandingDraftStore.getState().createDraft(null);
  const after = useLandingDraftStore.getState().drafts.length;
  const failures: string[] = [];
  if (after !== before + 1) {
    failures.push(`drafts ${before} -> ${after}, expected +1`);
  }
  if (draftId.length === 0) failures.push("createDraft returned an empty id");
  else seededDraftIds.push(draftId);
  return { ok: failures.length === 0, draftId, failures };
}

/** Remove only the drafts this seeder minted. */
export function teardownDraftTabs(): number {
  const store = useLandingDraftStore.getState();
  let removed = 0;
  for (const id of seededDraftIds) {
    store.closeDraft(id);
    removed += 1;
  }
  seededDraftIds = [];
  return removed;
}

/** Remove every `seed-header-` tab in this window. Teardown's remembered baseline does not survive reload or other windows. */
export interface PurgeReport {
  readonly removed: readonly string[];
  readonly remaining: number;
}

export function purgeSeededHeaderTabs(): PurgeReport {
  const store = useEpicCanvasStore.getState();
  const removed = store.openTabOrder.filter((id) =>
    id.startsWith("seed-header-"),
  );
  const keptTabs: Record<string, EpicViewTab | undefined> = {};
  for (const [tabId, tab] of Object.entries(store.tabsById)) {
    if (!tabId.startsWith("seed-header-")) keptTabs[tabId] = tab;
  }
  const keptCanvases: Record<string, EpicCanvasState | undefined> = {};
  for (const [tabId, canvas] of Object.entries(store.canvasByTabId)) {
    if (!tabId.startsWith("seed-header-")) keptCanvases[tabId] = canvas;
  }
  useEpicCanvasStore.setState((state) => ({
    ...state,
    tabsById: keptTabs,
    canvasByTabId: keptCanvases,
    openTabOrder: state.openTabOrder.filter(
      (id) => !id.startsWith("seed-header-"),
    ),
  }));
  preSeedOpenTabOrder = null;
  return {
    removed,
    remaining: useEpicCanvasStore
      .getState()
      .openTabOrder.filter((id) => id.startsWith("seed-header-")).length,
  };
}

export interface HeaderMeasurement {
  readonly total: number;
  readonly widths: readonly number[];
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly overflow: number;
}

/** Achieved header shape, after the render settles. */
export function measureHeaderTabs(): HeaderMeasurement {
  const items = [
    ...document.querySelectorAll<HTMLElement>("[data-strip-item-id]"),
  ];
  const scroller = document.querySelector<HTMLElement>(
    '[data-testid="header-tab-strip-scroll"]',
  );
  return {
    total: items.length,
    widths: items.map((el) =>
      Number(el.getBoundingClientRect().width.toFixed(1)),
    ),
    clientWidth: scroller?.clientWidth ?? 0,
    scrollWidth: scroller?.scrollWidth ?? 0,
    overflow: (scroller?.scrollWidth ?? 0) - (scroller?.clientWidth ?? 0),
  };
}

export function teardownHeaderTabs(): boolean {
  const order = preSeedOpenTabOrder;
  if (order === null) return false;
  useEpicCanvasStore.setState((state) => ({
    ...state,
    openTabOrder: [...order],
  }));
  preSeedOpenTabOrder = null;
  return true;
}

export function readSeededFingerprint(tabId: string): string {
  return fingerprintOf(tabId);
}

export interface SeedMeasurement {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly panes: readonly SeededPaneReport[];
  readonly overflow: readonly StripOverflowReport[];
  readonly fingerprint: string;
}

/** Live geometry after the render settles. Separate from `seed()`, which returns on the mutate tick. */
export function measureSeededFixture(
  tabId: string,
  requireAutoScrollOverflow: boolean,
): SeedMeasurement {
  const overflow = readOverflow();
  const failures: string[] = [];
  if (
    requireAutoScrollOverflow &&
    !overflow.some((o) => o.sufficientForAutoScroll)
  ) {
    failures.push(
      `no strip has overflow >= 2x widest tile: ${overflow
        .map(
          (o) => `${o.groupId.slice(0, 8)}=${o.overflow}px/${o.widestTile}px`,
        )
        .join(", ")}`,
    );
  }
  return {
    ok: failures.length === 0,
    failures,
    panes: paneReports(tabId),
    overflow,
    fingerprint: fingerprintOf(tabId),
  };
}

export interface SeededTabSummary {
  readonly tabId: string;
  readonly epicId: string;
  readonly paneCount: number;
  readonly tileCount: number;
}

/** Canvas is keyed by tab id; the header testid carries the epic id. List both so a driver does not read an empty canvas. */
export function listSeedableTabs(): readonly SeededTabSummary[] {
  const store = useEpicCanvasStore.getState();
  return Object.entries(store.canvasByTabId).flatMap(([tabId, canvas]) => {
    if (canvas === undefined) return [];
    const panes = paneReports(tabId);
    return [
      {
        tabId,
        epicId: store.tabsById[tabId]?.epicId ?? "",
        paneCount: panes.length,
        tileCount: panes.reduce((n, pane) => n + pane.tileIds.length, 0),
      },
    ];
  });
}

interface SeedFixtureBridge {
  readonly sentinel: string;
  readonly listTabs: () => readonly SeededTabSummary[];
  readonly roundTrip: (tabId: string) => RoundTripReport;
  readonly seedHeader: (count: number, epicId: string) => HeaderSeedReport;
  readonly teardownHeader: () => boolean;
  readonly measureHeader: () => HeaderMeasurement;
  readonly seedDraft: () => DraftSeedReport;
  readonly teardownDrafts: () => number;
  readonly purgeSeeded: () => PurgeReport;
  readonly measure: (
    tabId: string,
    requireAutoScrollOverflow: boolean,
  ) => SeedMeasurement;
  readonly seed: (
    tabId: string,
    spec: SeedFixtureSpec,
    hostId: string,
  ) => SeedFixtureReport;
  readonly teardown: () => TeardownReport;
  readonly restoreScroll: () => ScrollRestoreReport;
  readonly fingerprint: (tabId: string) => string;
}

/** Expose the seeder to a CDP driver. Called only from a DEV dynamic import. Attached with `Reflect.set`: a `declare global` would leak the harness type into production files. */
export function installSeedFixtureBridge(): void {
  const bridge: SeedFixtureBridge = {
    sentinel: SEED_FIXTURE_SENTINEL,
    listTabs: listSeedableTabs,
    measure: measureSeededFixture,
    roundTrip: checkSeededRoundTrip,
    seedHeader: seedHeaderTabs,
    teardownHeader: teardownHeaderTabs,
    measureHeader: measureHeaderTabs,
    seedDraft: seedDraftTab,
    teardownDrafts: teardownDraftTabs,
    purgeSeeded: purgeSeededHeaderTabs,
    seed: seedCanvasFixture,
    teardown: teardownCanvasFixture,
    restoreScroll: restoreSeededScroll,
    fingerprint: readSeededFingerprint,
  };
  Reflect.set(window, "__traycerSeedFixture", bridge);
}
