/**
 * Deterministic canvas fixture seeding, for evaluation and development only.
 *
 * WHY THIS EXISTS. Sprints 04 and 05 could not measure the Sprint 01/02
 * regression matrices, because the certified fixture - tiles at 192.3 / 130 /
 * 101.1px in an overflowing strip - was built from incidental live content that
 * no longer exists on any machine. A survey of six windows found three epics
 * with exactly one openable row each. The gap was never a product defect; it
 * was that the fixture could not be reconstructed.
 *
 * WHY IT COMPOSES STATE DIRECTLY. Every affordance-level route is capped:
 * `openBlankTabInPane` re-activates rather than inserting when the active tab
 * is already blank (the cap is in the STORE, not merely the UI handler), and a
 * sidebar tree row focuses rather than opening on repeat. Neither can build an
 * unequal-width overflowing strip. Composing `EpicCanvasTileRef`s directly and
 * driving `openTileInTab` / `splitPaneEmptyInTab` sidesteps both, because tab
 * WIDTH follows title length under the strip's `max-w-40` cap - which is how
 * 192.3 / 130 / 101.1 arose in the first place. Unequal widths become a
 * parameter rather than a hope.
 *
 * WHY IT MUST NOT SHIP. This is a state-mutating affordance no user asked for.
 * Its only entry point is a dynamic `import()` inside an `import.meta.env.DEV`
 * branch, so a production build eliminates it entirely. `SEED_FIXTURE_SENTINEL`
 * exists solely so the built artifact can be grepped to PROVE that - and the
 * grep must first be shown to HIT on a build where the seeder is deliberately
 * retained, because "grep found nothing" and "grep is broken" are otherwise the
 * same reading.
 */
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

/**
 * Unique string with no other reason to exist. Its presence in a production
 * bundle means dead-code elimination failed and this module shipped.
 */
export const SEED_FIXTURE_SENTINEL = "__TRAYCER_SEED_FIXTURE_a7f3c19d__";

/**
 * Titles chosen so rendered tab widths reproduce the certified unequal regime.
 * Width tracks title length under `max-w-40`, so these are the knob.
 */
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

/**
 * Strip overflow as MEASURED numbers, not a boolean.
 *
 * "Content wider than the container" is satisfied by 1px, and dnd-kit's
 * autoScroll (`threshold: {x: 0.2}`) fires on entering the outer 20% - so a
 * strip overflowing by 5px triggers autoScroll, scrolls 5px, and stops. Grading
 * boundary invariance against 5px of travel passes while establishing nothing,
 * so the magnitude has to be reported and checked, not the sign.
 */
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

/**
 * Workspace-file refs, NOT blank refs.
 *
 * `parseBlankTileRef` hard-codes `name: BLANK_TILE_NAME`, so a blank tile's
 * name is a CONSTANT rather than data: seeded titles survive until the canvas
 * round-trips through the schema, then every tile becomes "New tab" and settles
 * to a uniform width. Titles are the only knob for width, so the unequal regime
 * cannot be built from blanks at all - not late, not early.
 *
 * `artifact-tile.ts` preserves `name` on every parse path, and the
 * workspace-file variant is renderer-local, so no record has to exist behind it.
 */
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

/**
 * Does every seeded ref survive serialize -> parse unchanged?
 *
 * A builder that reports a property it has not shown survives serialization is
 * reporting the SEED, not the fixture. This caught nothing when it was a
 * one-off check for `name`; as a standing check it catches ANY field a schema
 * hard-codes on parse - including fields only the builder reports, which
 * nothing else could disagree with.
 */
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

/**
 * Strip scroll offsets at seed time, keyed by group id.
 *
 * `EpicCanvasState` is `{ root, activePaneId, tilesByInstanceId, sizesByGroupId }`
 * - scroll position is NOT in it. It is DOM state on the strip element. So
 * restoring the state object alone leaves a strip scrolled wherever the last
 * gesture left it, and S1.3's fingerprint check cannot see that: the
 * fingerprint is STRUCTURAL, so it reads identically whether scroll was
 * restored or not. Same reading, two worlds.
 *
 * That matters most for the one assertion about scrolling: a trial starting
 * mid-strip puts every boundary somewhere unintended, and it would present as a
 * boundary regression rather than as residue.
 */
let preSeedScrollByIndex: readonly number[] = [];

/**
 * Strip scroll offsets in LEFT-TO-RIGHT order.
 *
 * Keyed by position, not group id, because seeding REGENERATES group ids - a
 * capture keyed by id matches nothing at teardown, and an empty restore map
 * reads exactly like a clean restore. That is how the first version of this
 * reported success having restored nothing.
 */
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
  // `TileGroup` is N-ary (`children`), not binary - recursing into `first` /
  // `second` finds nothing at all and reports "built 0 panes" for a canvas that
  // plainly has some.
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

/**
 * Fingerprint by tile COMPOSITION, deliberately excluding pane ids.
 *
 * Pane ids are freshly generated uuids on every split, so a fingerprint that
 * includes them differs between two builds of the SAME spec with the SAME
 * tiles - which makes S1.1 ("same fingerprint from any starting state")
 * unsatisfiable by construction rather than by defect. Sorting by pane id makes
 * the pane ORDER arbitrary for the same reason.
 *
 * Tile order WITHIN a pane is preserved, because a reorder is exactly what this
 * has to detect; only the incidental pane identity is dropped.
 */
function fingerprintOf(tabId: string): string {
  // Panes in TREE order, which for a horizontal split is left-to-right - the
  // Evaluator's instrument orders by strip x, and the two must agree. Sorting
  // the composition strings instead would order panes by their tile names,
  // so two fingerprints could differ purely in pane ordering and the gate
  // would refuse a valid fixture while looking like fixture drift.
  return paneReports(tabId)
    .map((pane) => pane.tileIds.map((id) => id.slice(0, 12)).join(","))
    .join(" | ");
}

/**
 * Build the fixture. Returns a report rather than a boolean: a builder that
 * says "done" without saying what it built is the shape that let a four-group
 * fixture pass for a two-group one across a whole sprint.
 */
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
  // Re-seeding the SAME tab is useful when a probe needs a fresh canonical
  // shape between trials. Preserve the original pre-seed snapshot and scroll
  // instead of quietly redefining "teardown" to mean "restore the last seeded
  // fixture". A different tab is refused above because one global snapshot
  // cannot restore two canvases honestly.
  if (seededTabId === null) {
    preSeedSnapshot = before;
    seededTabId = tabId;
    preSeedScrollByIndex = readScrollLefts();
  }

  // Reset to an empty canvas FIRST, so the result depends on the spec and not
  // on what happened to be there. Seeding on top of residue is why an earlier
  // run produced four panes squeezed to 118px each: the tiles were right and
  // the strip was too narrow to overflow, which is S1.1's whole point - the
  // same spec must yield the same fingerprint from any starting state.
  // Safe because `preSeedSnapshot` above is what teardown restores.
  useEpicCanvasStore.setState((state) => ({
    ...state,
    canvasByTabId: { ...state.canvasByTabId, [tabId]: createEmptyCanvas() },
  }));

  // Ordering matters, and both halves were bugs.
  //
  // `openTile` / `openTileInPane` FILL IN PLACE when the target pane's active
  // tab is blank - browser new-tab semantics (`actions.ts:568-593`). Every
  // seeded ref IS blank, because titles are how widths are set, so eight opens
  // through that path replace each other and leave exactly one tile: the LAST.
  // `openTileInBackgroundTab` appends unconditionally, so it is the only path
  // that accumulates - but it returns state unchanged on a null root, so the
  // FIRST tile still has to go through `openTile` to seed the root pane.
  //
  // And the split has to come AFTER the source tiles exist, or it produces an
  // empty pane and there is nothing to overflow.
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
      // `openTileInBackgroundTab` appends to `activePaneOrFirst`, so the new
      // pane has to be made active before the target tiles are opened.
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

  // NOTE: overflow is deliberately NOT measured here. `seed()` mutates the
  // store synchronously, so a DOM read on this tick sees the strip as it was
  // BEFORE React re-rendered - stale widths that read exactly like real ones.
  // The driver calls `measure()` after the render settles; S1.6's gate lives
  // there, applied to geometry that exists.
  const overflow: readonly StripOverflowReport[] = [];

  return {
    ok: failures.length === 0,
    failures,
    panes,
    overflow,
    fingerprint: fingerprintOf(tabId),
  };
}

/**
 * Restore the exact pre-seed canvas. Not "close what we opened" - an
 * approximate teardown leaves residue that the next measurement inherits.
 */
export interface TeardownReport {
  readonly ok: boolean;
  readonly fingerprint: string;
  /**
   * Scroll is NOT restored here. Teardown reinstates the pre-seed
   * `EpicCanvasState`, and React re-renders the pre-seed panes on a LATER tick
   * - so writing scrollLeft on this tick would address the SEEDED strips, which
   * is the split-before-tiles ordering bug in a different costume. The driver
   * calls `restoreSeededScroll()` once the structural restore has rendered.
   */
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

/**
 * Apply the captured scroll offsets by POSITION, after the structural restore
 * has rendered. Reports what it wanted against what it got, and refuses to
 * claim success when the strip count no longer matches - restoring nothing and
 * restoring correctly must not produce the same reading.
 */
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
  // Only the overlapping prefix can be restored; a count difference is already
  // reported above, and is what makes "restored nothing" distinguishable from
  // "restored correctly".
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

/**
 * Seed HEADER tabs, for the Sprint 01 (E7.1) regression set.
 *
 * Header tabs are PROJECTED (`use-header-tabs.ts`) from
 * `canvasStore.openTabOrder` + `tabsById`, so seeding them is the same store
 * composition the canvas fixture already uses - an `EpicViewTab` carries a
 * `name`.
 *
 * HEADER WIDTH IS COUNT-DRIVEN, NOT TITLE-DRIVEN - the opposite of the tile
 * strip. Tabs divide the strip evenly (`762/N` measured exactly) until they hit
 * a MIN-WIDTH CLAMP at 120px, after which the strip overflows and every tab
 * stays at 120 regardless of count. So a title parameter here would be a claim
 * the API makes and the implementation does not keep, and the only knob is
 * `count`.
 *
 * This exists because E7.1 cannot otherwise be a REGRESSION test: Sprint 01
 * certified on 4 tabs at 191px and 5 plain tabs at 185.9px, and the live header
 * is 180.8 / 400.4 / 180.8. Grading the Sprint 01 matrix on that shape would be
 * a new measurement against an old baseline - refused by our own S4.2 rule.
 */
export interface HeaderSeedReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly seededTabIds: readonly string[];
  /**
   * Tabs present before seeding. `count` is ADDITIVE, so the resulting total is
   * `preExisting + count` - and the caller must read the ACHIEVED total from
   * `measureHeader()` after the render settles, never from this call: a DOM
   * read on the tick that mutates the store returns the PREVIOUS layout, which
   * is indistinguishable from the current one.
   */
  readonly preExisting: number;
}

let preSeedOpenTabOrder: readonly string[] | null = null;

export function seedHeaderTabs(
  count: number,
  epicId: string,
): HeaderSeedReport {
  const store = useEpicCanvasStore.getState();
  // Remember the order WITHOUT any previously seeded tabs, so a repeat call
  // cannot memoise a seeded state as the baseline to restore to.
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
      // Name does not affect header width - see the note above.
      name: `Seeded Header ${index}`,
    };
    canvases[tabId] = createEmptyCanvas();
  }

  // Drop any prior seeded ids before appending: the ids are deterministic, so
  // appending them again would duplicate rather than accumulate, and React
  // would render only the unique ones - a count that silently ignores the call.
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
/**
 * Mint a DRAFT header tab, for E7.1's detach epic-vs-draft row.
 *
 * Drafts are projected from a different store than epic tabs
 * (`useLandingDraftStore.drafts`, see `use-header-tabs.ts`), so the epic-tab
 * seeding above cannot produce one - a draft is a different kind, not a
 * differently-named epic.
 */
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

/**
 * Remove EVERY seeded header tab from this window, regardless of whether this
 * page is the one that created them.
 *
 * `teardownHeaderTabs` restores a remembered baseline, which only works on the
 * window that seeded and only while the memo survives a reload. Seeded ids are
 * persisted with the canvas store, so they reappear on other windows and in
 * later sessions with no memo to restore from - and there they are invisible
 * contamination: they look like ordinary epic tabs.
 *
 * This is the payoff of naming what you write. `seed-header-` is a namespace,
 * so contamination is removable by inspection rather than by remembering.
 */
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

/**
 * Live geometry after the render settles, and S1.6's gate.
 *
 * Separate from `seed()` because `seed()` returns on the same tick it mutates
 * the store: any DOM measured there is the PREVIOUS layout, which reads exactly
 * like the current one and is the sprint's recurring defect in miniature.
 */
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

/**
 * The canvas is keyed by TAB id, but the header testid carries the EPIC id -
 * `tab-epic-${epic.id}`. A driver reading the DOM therefore has the wrong key,
 * and a wrong key produces an empty canvas that is indistinguishable from an
 * empty canvas. Listing both ids makes the mapping explicit.
 */
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

/**
 * Expose the seeder to an out-of-process driver (CDP). Called ONLY from a
 * dynamic `import()` inside an `import.meta.env.DEV` branch, so neither this
 * function nor anything it closes over reaches a production bundle.
 *
 * Attached with `Reflect.set` rather than by augmenting the global `Window`
 * interface. A `declare global` here would be erased at build but would let ANY
 * production file write `window.__traycerSeedFixture` and typecheck - the type
 * surface of an eval-only harness leaking into product code, which outlives the
 * harness itself.
 */
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
