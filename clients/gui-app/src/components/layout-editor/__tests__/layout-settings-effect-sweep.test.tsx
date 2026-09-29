import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  holdClocksStill,
  MINTED_ID_KINDS,
  normalisedMintedIds,
  resetToShippedLayout,
  sameSignature,
  shippedLayoutSnapshot,
  SWEEP_CONFIGURED_PROVIDERS,
  type SweepMount,
  type SweepWindow,
} from "@/components/layout-editor/__tests__/layout-sweep-fixtures";
import {
  mountSweepSettingsPanel,
  mountSweepWindow,
} from "@/components/layout-editor/__tests__/layout-sweep-harness";
import {
  buildSweepPlan,
  buttonControl,
  checkControl,
  orderControl,
  radioControl,
  switchControl,
  sweepCounts,
  sweepEntryName,
  type SweepContext,
  type SweepEntry,
  type SweepStep,
} from "@/components/layout-editor/__tests__/layout-sweep-plan";
import type { FineTuneRowFacts } from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import type { AnyGrammarRow } from "@/components/layout-editor/regions/region-facts";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import {
  asBarRegionId,
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { isMobileApp } from "@/lib/mobile-app";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import {
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * EVERY LAYOUT SETTING CHANGES THE APP COLUMN, in jsdom.
 *
 * This used to be the slow half of the retired CDP driver for Settings >
 * Layout ("every setting does something"). That driver clicked each control of the
 * real Settings page in Chrome, one at a time from the shipped layout, and
 * failed when the app column rendered the same afterwards, on the reasoning
 * that a setting nothing reads is exactly a setting whose operation leaves the
 * product unchanged.
 *
 * This file keeps the claim and drops the browser. It mounts the app column
 * ONCE per window - the sample workspace and a task's window, composed from the
 * production components (`layout-sweep-harness.tsx`) - and then, per setting
 * value: puts the stores back to the shipped layout, takes a baseline signature
 * (the column's whole `innerHTML`), writes the value through the function the
 * product's own control calls, and takes a second signature. Nothing is
 * re-mounted between entries and nothing is clicked.
 *
 * What makes the comparison honest:
 * - The signature strips nothing but React's minted ids, which a test below
 *   proves differ between two identical renders. `style` and `data-state` stay
 *   in, so a setting that moves only a width or a state is seen.
 * - The clocks the column moves on by itself are held still
 *   (`holdClocksStill`), and a noise control per window proves two signatures
 *   with no write between them are equal, over an observation window a running
 *   animation would not survive.
 * - Every write is first asserted to have changed the STORED layout, so a
 *   setting the store refused cannot pass as "changed the app".
 * - The plan is built from the registries the page draws from and held to the
 *   real page: a census of the controls a person can operate on the mounted
 *   Settings > Layout panel must be exactly the controls the plan stands for.
 * - Silence is allowed only as typed data with a reason, and checked both ways.
 */

const AVAILABILITY: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: isMobileApp(),
};

const WINDOWS: ReadonlyArray<SweepWindow> = ["sample", "epic"];

// ── Silence, as data ────────────────────────────────────────────────────────

/**
 * Operations that change a setting and, by design, nothing on screen - each
 * with the ruling that says so. Anything else that changes nothing fails, and
 * so does an entry listed here that DOES change something: a stale exemption
 * is a setting that started working with nobody noticing the list.
 *
 * Ported from the driver's `EXPECTED_SILENT`, entry by entry: what still holds
 * in jsdom is kept, what no longer holds is gone (the Pull requests and
 * Comments rule finds no pull requests in either window, but a Shown pin draws
 * the rail icon in the task window, so those are not silent here), and what
 * jsdom adds is new (the parked-readings memory, which nothing draws from).
 */
interface SilentExemption {
  readonly id: string;
  readonly matches: (entry: SweepEntry) => boolean;
  readonly why: string;
}

const CONFIGURED_PREFIXES = SWEEP_CONFIGURED_PROVIDERS.map(
  (providerId) => `provider-display:${providerId}:`,
);

const EXPECTED_SILENT: ReadonlyArray<SilentExemption> = [
  {
    id: "limits-choose",
    matches: (entry) =>
      entry.source === "provider-limits" && entry.id.endsWith(":choose"),
    why: "Choose seeds its picks with what Automatic draws, so the picture does not move until a pick changes",
  },
  {
    id: "limits-automatic",
    matches: (entry) =>
      entry.source === "provider-limits" && entry.id.endsWith(":automatic"),
    why: "back from Choose..., whose picks were seeded with the window Automatic draws, so the picture is the same",
  },
  {
    id: "unconfigured-provider-hidden",
    matches: (entry) =>
      entry.source === "provider-display" &&
      !CONFIGURED_PREFIXES.some((prefix) => entry.id.startsWith(prefix)),
    why: "the watched host has signed in Codex and Claude Code only, so every other provider draws no reading to hide",
  },
  {
    id: "model-reasoning-control",
    matches: (entry) =>
      entry.id.startsWith("region-style:model:reasoningControl"),
    why: "the footer it styles is inside the model picker, which is closed here; the row pictures both options, and the editor opens its sample picker while Model is selected (L-173)",
  },
  {
    id: "side-foot-single-move",
    matches: (entry) =>
      entry.id.includes(":side-foot:") && entry.given.length === 1,
    why: "the tab strip's foot draws its readings as one row, the header's left end then its right end with usage before resources inside an end; with usage at the start and resources at the end either one moved alone leaves that order as it was (the entry that moves both, and flips it, must change the column)",
  },
  {
    id: "status-bar-parked",
    matches: (entry) => entry.id === "arrangement-field:statusBarParked",
    why: "it only remembers what the Toggle status bar command last sent up, for the next press to bring back; nothing draws from it",
  },
];

// ── The sweep ───────────────────────────────────────────────────────────────

interface EntryResult {
  readonly entry: SweepEntry;
  /** The write changed the stored layout. */
  readonly stored: boolean;
  /** The app column rendered differently afterwards. */
  readonly changed: boolean;
  /** Nothing moved between the baseline and a second look at it, before the write. */
  readonly baselineHeld: boolean;
}

interface WindowRun {
  readonly window: SweepWindow;
  readonly pristine: string;
  /** The pristine column after one warm-up pass, and after a second. */
  readonly warmed: string;
  readonly idle: ReadonlyArray<string>;
  /** After a store write that changes nothing: the same layout, written back. */
  readonly nullWrite: string;
  readonly plan: ReadonlyArray<SweepEntry>;
  readonly results: ReadonlyArray<EntryResult>;
  readonly elapsedMs: number;
}

/** How many settles the noise control watches, and how long it waits between. */
const IDLE_SETTLES = 12;
const IDLE_GAP_MS = 25;

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function planFor(mount: SweepMount): ReadonlyArray<SweepEntry> {
  return buildSweepPlan({
    shipped: shippedLayoutSnapshot(),
    availability: AVAILABILITY,
    configuredProviders: SWEEP_CONFIGURED_PROVIDERS,
    usage: mount.providerUsage(),
  });
}

/** Every entry's writes once, in order, with nothing read. */
async function warmUp(
  mount: SweepMount,
  plan: ReadonlyArray<SweepEntry>,
  context: SweepContext,
): Promise<void> {
  for (const entry of plan) {
    await mount.poke(() => {
      resetToShippedLayout();
    });
    for (const step of entry.given) {
      await mount.poke(() => {
        step.run(context);
      });
    }
    await mount.poke(() => {
      entry.write.run(context);
    });
  }
}

async function sweepWindow(windowKind: SweepWindow): Promise<WindowRun> {
  const started = performance.now();
  const mount = await mountSweepWindow(windowKind);
  const context: SweepContext = {
    providerUsage: (providerId) =>
      mount.providerUsage().get(providerId) ?? null,
  };
  const plan = planFor(mount);

  // Warm-up: every entry once, unrecorded. A tree keeps things it only sets
  // the first time something re-renders (dnd-kit puts an inline
  // `transition: transform 0ms linear` on a sortable row the first time its
  // list re-renders), and a baseline taken before that would see the first
  // write of a setting that changes nothing as a change. After a pass every
  // such thing has happened, and a second pass proves none is left.
  await warmUp(mount, plan, context);
  await mount.apply(() => {
    resetToShippedLayout();
  });
  const warmed = mount.signature();
  await warmUp(mount, plan, context);
  await mount.apply(() => {
    resetToShippedLayout();
  });
  const stillWarm = mount.signature();

  // The noise control: settled, then watched with nothing written.
  const pristine = stillWarm;
  const idle: string[] = [pristine];
  for (let index = 0; index < IDLE_SETTLES; index += 1) {
    await mount.settle();
    await pause(IDLE_GAP_MS);
    idle.push(mount.signature());
  }

  // The other half of the control: a write that changes nothing, which
  // re-renders every subscriber, must not change the HTML either.
  await mount.apply(() => {
    useLayoutStore.getState().replaceAll(getLayoutSnapshot());
  });
  const nullWrite = mount.signature();

  const results: EntryResult[] = [];
  for (const entry of plan) {
    await mount.apply(() => {
      resetToShippedLayout();
    });
    for (const step of entry.given) {
      await mount.apply(() => {
        step.run(context);
      });
    }
    const before = mount.signature();
    // Per entry, the same control: nothing moved without a write.
    await mount.settle();
    const baselineHeld = mount.signature() === before;
    const storedBefore = JSON.stringify(getLayoutSnapshot());
    await mount.apply(() => {
      entry.write.run(context);
    });
    const stored = JSON.stringify(getLayoutSnapshot()) !== storedBefore;
    results.push({
      entry,
      stored,
      changed: !sameSignature(mount.signature(), before),
      baselineHeld,
    });
  }

  mount.unmount();
  return {
    window: windowKind,
    pristine,
    warmed,
    idle,
    nullWrite,
    plan,
    results,
    elapsedMs: performance.now() - started,
  };
}

let releaseClocks: (() => void) | null = null;
const runs = new Map<SweepWindow, WindowRun>();

function runOf(windowKind: SweepWindow): WindowRun {
  const run = runs.get(windowKind);
  if (run === undefined) throw new Error(`${windowKind} was not swept`);
  return run;
}

beforeAll(async () => {
  releaseClocks = holdClocksStill();
  for (const windowKind of WINDOWS) {
    runs.set(windowKind, await sweepWindow(windowKind));
  }
}, 120_000);

afterAll(() => {
  releaseClocks?.();
});

/** One entry across both windows: what it changed anywhere. */
interface Verdict {
  readonly entry: SweepEntry;
  readonly stored: boolean;
  readonly changedIn: ReadonlyArray<SweepWindow>;
}

function verdicts(): ReadonlyArray<Verdict> {
  const sample = runOf("sample");
  const epic = runOf("epic");
  return sample.results.map((result) => {
    const other = epic.results.find(
      (candidate) => candidate.entry.id === result.entry.id,
    );
    const changedIn: SweepWindow[] = [];
    if (result.changed) changedIn.push("sample");
    if (other?.changed === true) changedIn.push("epic");
    return {
      entry: result.entry,
      stored: result.stored && other?.stored === true,
      changedIn,
    };
  });
}

function exemptionFor(entry: SweepEntry): SilentExemption | null {
  return EXPECTED_SILENT.find((exemption) => exemption.matches(entry)) ?? null;
}

describe("every layout setting changes the app column", () => {
  it("is the same plan in both windows, with unique entries", () => {
    const sample = runOf("sample").plan.map((entry) => entry.id);
    const epic = runOf("epic").plan.map((entry) => entry.id);
    expect(epic).toEqual(sample);
    expect(new Set(sample).size).toBe(sample.length);
  });

  it("noise control: two signatures with no write between them are equal, in each window", () => {
    for (const windowKind of WINDOWS) {
      const run = runOf(windowKind);
      const drifted = run.idle.filter(
        (signature) => signature !== run.pristine,
      );
      expect(drifted.length, `${windowKind} drifted while idle`).toBe(0);
      // A write of the layout the stores already hold re-renders every
      // subscriber and must leave the HTML exactly as it was.
      expect(
        sameSignature(run.nullWrite, run.pristine),
        `${windowKind} changed on a write that changes nothing`,
      ).toBe(true);
    }
  });

  it("warm-up is exhaustive: a second pass over every write leaves the pristine column as the first did", () => {
    for (const windowKind of WINDOWS) {
      const run = runOf(windowKind);
      expect(
        sameSignature(run.warmed, run.pristine),
        `${windowKind} was still changing after its first warm-up pass`,
      ).toBe(true);
    }
  });

  it("noise control, per entry: nothing moved between the baseline and a second look at it", () => {
    const unsteady: string[] = [];
    for (const windowKind of WINDOWS) {
      for (const result of runOf(windowKind).results) {
        if (!result.baselineHeld)
          unsteady.push(`${windowKind}: ${result.entry.id}`);
      }
    }
    expect(unsteady).toEqual([]);
  });

  it("counter-minted ids are the only thing two identical renders differ by", async () => {
    const first = await mountSweepWindow("sample");
    const rawFirst = first.rawHtml();
    first.unmount();
    const second = await mountSweepWindow("sample");
    const rawSecond = second.rawHtml();
    second.unmount();
    // Each kind is stripped only if it is EARNED: it occurs in the column and
    // its values are not the same in two renders of the same tree.
    for (const kind of MINTED_ID_KINDS) {
      const inFirst = new Set(rawFirst.match(kind.pattern) ?? []);
      const inSecond = new Set(rawSecond.match(kind.pattern) ?? []);
      expect(inFirst.size, `${kind.name} occurs`).toBeGreaterThan(0);
      expect(
        [...inFirst].some((id) => !inSecond.has(id)),
        `${kind.name} differs between renders`,
      ).toBe(true);
    }
    // And with them normalised nothing else differs.
    expect(rawFirst === rawSecond).toBe(false);
    expect(
      normalisedMintedIds(rawFirst) === normalisedMintedIds(rawSecond),
    ).toBe(true);
  }, 60_000);

  it("every write changed the stored layout", () => {
    const unstored = verdicts()
      .filter((verdict) => !verdict.stored)
      .map((verdict) => sweepEntryName(verdict.entry));
    expect(unstored).toEqual([]);
  });

  it("every setting value changes the app column somewhere, or is a typed exemption", () => {
    const silent = verdicts()
      .filter(
        (verdict) =>
          verdict.changedIn.length === 0 &&
          exemptionFor(verdict.entry) === null,
      )
      .map((verdict) => `no visible effect: ${sweepEntryName(verdict.entry)}`);
    expect(silent).toEqual([]);
  });

  it("every exemption is exact: it matches something, and that something is silent", () => {
    const stale: string[] = [];
    for (const exemption of EXPECTED_SILENT) {
      const matched = verdicts().filter((verdict) =>
        exemption.matches(verdict.entry),
      );
      if (matched.length === 0) stale.push(`${exemption.id}: matches no entry`);
      for (const verdict of matched) {
        if (verdict.changedIn.length > 0) {
          stale.push(
            `${exemption.id}: ${sweepEntryName(verdict.entry)} changed the ${verdict.changedIn.join(" and ")} window`,
          );
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("sweeps more settings than the old driver's floor", () => {
    expect(runOf("sample").results.length).toBeGreaterThan(60);
    const counts = sweepCounts(runOf("sample").plan);
    expect([...counts.values()].every((count) => count > 0)).toBe(true);
  });
});

// ── The plan, held to the registries and to the real page ───────────────────

interface Sweep {
  readonly kind: "swept";
}

interface NotSwept {
  readonly kind: "not-swept";
  readonly why: string;
}

interface Heading {
  readonly kind: "heading";
  readonly why: string;
}

const SWEPT: Sweep = { kind: "swept" };

function notSwept(why: string): NotSwept {
  return { kind: "not-swept", why };
}

function heading(why: string): Heading {
  return { kind: "heading", why };
}

type LayoutDefinitionKey = keyof typeof LAYOUT.definitions;

/**
 * Every row and card of the Layout page's own definitions: swept, a heading
 * (a card's name, whose rows are the settings and are swept as themselves), or
 * not swept with the reason. A `Record`, so a definition added to the page is a
 * compile error here until someone decides which of the three it is; the
 * runtime check below holds each answer to what the plan really covers and to
 * the definition's own `kind`.
 */
const DEFINITION_SWEEP: Record<
  LayoutDefinitionKey,
  Sweep | NotSwept | Heading
> = {
  customizeEntry: notSwept(
    "a button that opens the layout editor on a sample workspace: it navigates and writes no setting",
  ),
  presets: SWEPT,
  topBar: heading("the Task tabs card; its rows are swept as themselves"),
  tabStripPlacement: SWEPT,
  sideStripView: SWEPT,
  taskTabLayout: SWEPT,
  sidebar: heading("the Sidebar card; its rows are swept as themselves"),
  sidebarSide: SWEPT,
  resourceReadings: SWEPT,
  chat: heading("the Chat card; its rows are swept as themselves"),
  readingWidth: SWEPT,
  composer: heading("the Composer card; its rows are swept as themselves"),
  statusBar: heading(
    "the Usage and resources card; its rows are swept as themselves",
  ),
  mobileFooter: notSwept(
    "the row exists only in the installed mobile app (isMobileFooterRowAvailable), and it decides what draws only on a mobile viewport; this composition is a desktop window, so there is no control to operate and nothing to draw",
  ),
  resetLayout: SWEPT,
  resetLayoutAction: SWEPT,
};

/**
 * Every field of an arrangement: swept, or not swept with the reason. A
 * `Record` over the type's own keys, so a field added to the arrangement is a
 * compile error here; the runtime check reads the shipped arrangement's keys
 * as well, for a field that reaches the object without reaching the type.
 */
const ARRANGEMENT_SWEEP: Record<keyof LayoutArrangement, Sweep | NotSwept> = {
  dock: SWEPT,
  toolbarLeft: SWEPT,
  toolbarRight: SWEPT,
  rail: SWEPT,
  usageProviders: SWEPT,
  hiddenProviders: SWEPT,
  providerLimits: SWEPT,
  shownProfiles: notSwept(
    "written only by the usage popover's account checklist, never by a Layout setting, and it changes what draws only for a provider with more than one account: this host lists no profiles, so no selection could change the column",
  ),
  usageHost: SWEPT,
  usageSide: SWEPT,
  resourceHost: SWEPT,
  resourceSide: SWEPT,
  minimapSide: SWEPT,
  statusBarParked: SWEPT,
  pinnedContextFieldOrder: SWEPT,
  mobileFooter: notSwept(
    "see the mobileFooter row: only the installed mobile app offers it, and it decides the status bar only on a mobile viewport",
  ),
  dividerSeq: SWEPT,
  tabStripPlacement: SWEPT,
  sidebarSide: SWEPT,
  sideStripView: SWEPT,
  taskTabLayout: SWEPT,
  readingWidth: SWEPT,
};

/**
 * The grammar's row kinds and control kinds, and how the plan sweeps each.
 * `Record`s over the registry's own unions: a new kind is a compile error until
 * the plan has a way to write it.
 */
type GrammarRowKind = AnyGrammarRow["kind"];
type ControlSpecKind = FineTuneRowFacts["control"]["kind"];

const GRAMMAR_ROW_SWEEP: Record<GrammarRowKind, string> = {
  "position-host": "region-position: one entry per unchecked bar",
  "position-side": "region-position: one entry per unchecked side",
  "position-order":
    "order-list: the group's list, its first movable row down and its second up",
  style: "region-style: one entry per unchecked example",
  "fine-tune": "region-fine-tune: one entry per control option",
  children: "provider-display and provider-limits: the Providers list",
};

const CONTROL_SPEC_SWEEP: Record<ControlSpecKind, string> = {
  switch: "toggled",
  segment: "each unchecked option",
  checks: "each box toggled, after the switch it needs is on",
  "field-checks": "each option toggled, never the last one left on",
};

/** Regions whose one display control does not exist, and why. */
const NO_DISPLAY_CONTROL: ReadonlyArray<{
  readonly region: string;
  readonly why: string;
}> = [
  {
    region: "model",
    why: "the model picker always draws (it also owns the picker shortcut): it has a Style and a Reasoning control and no Shown or size (G6)",
  },
];

/** Region controls the plan does not write, each with the reason. Empty is the goal. */
const NOT_SWEPT_REGION_CONTROLS: ReadonlyArray<{
  readonly identity: string;
  readonly why: string;
}> = [];

/** Controls on the real page the plan has no entry for, each with the reason. */
const NOT_SWEPT_PAGE_CONTROLS: ReadonlyArray<{
  readonly matches: (key: string) => boolean;
  readonly why: string;
}> = [];

function coveredIdentities(
  plan: ReadonlyArray<SweepEntry>,
): ReadonlySet<string> {
  return new Set(plan.flatMap((entry) => entry.covers));
}

/**
 * What the region registry says has a control, walked straight off the
 * registry - not off the plan builder's own list of regions - so a region the
 * builder never visits is still asked for.
 */
function registryIdentities(): ReadonlyArray<string> {
  const identities: string[] = [];
  for (const region of Object.values(LAYOUT_REGIONS)) {
    if (!NO_DISPLAY_CONTROL.some((entry) => entry.region === region.id)) {
      identities.push(`display:${region.id}`);
    }
    const rows: ReadonlyArray<AnyGrammarRow> = region.rows;
    for (const row of rows) {
      switch (row.kind) {
        case "position-host":
          if (asBarRegionId(region.id) !== null) {
            identities.push(`position-host:${region.id}`);
          }
          break;
        case "position-side":
          identities.push(`position-side:${region.id}`);
          break;
        case "position-order":
          identities.push(`order:${row.group}`);
          break;
        case "style":
          identities.push(`style:${region.id}:${row.key}`);
          break;
        case "children":
          identities.push(
            "order:usageProviders",
            "provider-display",
            "provider-limits",
          );
          break;
        case "fine-tune":
          for (const detail of row.rows) {
            identities.push(`fine-tune:${region.id}:${detail.id}`);
          }
          break;
        default:
          throw new Error(
            `${region.id} has a grammar row the guard does not know`,
          );
      }
    }
  }
  return [...new Set(identities)];
}

/** The identities a plan may name that are not region controls at all. */
const NON_REGION_COVERS: ReadonlyArray<string> = ["rail:divider", "rail:stack"];

function definitionKeys(): ReadonlyArray<LayoutDefinitionKey> {
  return Object.keys(LAYOUT.definitions).filter(
    (key): key is LayoutDefinitionKey => key in LAYOUT.definitions,
  );
}

function arrangementKeys(): ReadonlyArray<keyof LayoutArrangement> {
  return Object.keys(DEFAULT_ARRANGEMENT).filter(
    (key): key is keyof LayoutArrangement => key in DEFAULT_ARRANGEMENT,
  );
}

// ── The real page's controls ────────────────────────────────────────────────

/** A row-less control: a surface-level row sits in no sortable row. */
const NO_ROW = "-";

interface PageControl {
  readonly node: HTMLElement;
  /** Operable now, and not the option already checked. */
  readonly live: boolean;
  readonly checked: boolean;
}

function operable(node: HTMLElement): boolean {
  if (node.hasAttribute("disabled") || node.hasAttribute("data-disabled")) {
    return false;
  }
  if (node.closest("[inert]") !== null) return false;
  return node.closest("fieldset[disabled]") === null;
}

function rowIdOf(node: Element): string {
  return (
    node.closest("[data-sortable-id]")?.getAttribute("data-sortable-id") ??
    NO_ROW
  );
}

function nameOf(node: Element): string {
  return (
    node.getAttribute("aria-label") ??
    node.closest("label")?.textContent ??
    node.textContent
  ).trim();
}

const RAIL_VERBS =
  /^(Stack .* with the panel below|Unstack .*|Remove stack|Remove divider)$/;

/**
 * Every control a person can operate on the mounted Settings > Layout page,
 * named as the plan names them: the driver's own inventory - each unchecked
 * option of each radio group, each switch, each checkbox, and the first movable
 * row of each ordered list moved down one and the second moved up one - plus
 * the rail's own buttons, which the driver's `[data-stack-slot]` selector (a
 * marker no production element carries any more) never found.
 */
function pageControls(root: HTMLElement): ReadonlyMap<string, PageControl> {
  const controls = new Map<string, PageControl>();
  addRadioControls(root, controls);
  addSwitchControls(root, controls);
  addCheckboxControls(root, controls);
  addButtonControls(root, controls);
  addOrderControls(root, controls);
  return controls;
}

function liveControl(node: HTMLElement): PageControl {
  return { node, live: true, checked: false };
}

function addRadioControls(
  root: HTMLElement,
  controls: Map<string, PageControl>,
): void {
  for (const group of root.querySelectorAll<HTMLElement>(
    '[role="radiogroup"]',
  )) {
    for (const option of group.querySelectorAll<HTMLElement>(
      '[role="radio"]',
    )) {
      // The checked option is listed too, marked, so a return to it (the
      // mirror of a write the plan already makes) is told from a control the
      // plan has not met.
      const checked = option.getAttribute("aria-checked") === "true";
      controls.set(
        radioControl(
          rowIdOf(group),
          group.getAttribute("aria-label") ?? "",
          nameOf(option),
        ),
        { node: option, live: !checked && operable(option), checked },
      );
    }
  }
}

function addSwitchControls(
  root: HTMLElement,
  controls: Map<string, PageControl>,
): void {
  for (const node of root.querySelectorAll<HTMLElement>('[role="switch"]')) {
    if (!operable(node)) continue;
    controls.set(switchControl(rowIdOf(node), nameOf(node)), liveControl(node));
  }
}

function addCheckboxControls(
  root: HTMLElement,
  controls: Map<string, PageControl>,
): void {
  for (const node of root.querySelectorAll<HTMLElement>('[role="checkbox"]')) {
    if (!operable(node)) continue;
    const label =
      node.closest("label")?.textContent ??
      root.ownerDocument.querySelector(`label[for="${node.id}"]`)
        ?.textContent ??
      "";
    controls.set(checkControl(rowIdOf(node), label.trim()), liveControl(node));
  }
}

function addButtonControls(
  root: HTMLElement,
  controls: Map<string, PageControl>,
): void {
  for (const node of root.querySelectorAll<HTMLElement>("button")) {
    if (!operable(node)) continue;
    const name = nameOf(node);
    if (RAIL_VERBS.test(name) || name === "Add divider") {
      controls.set(buttonControl(rowIdOf(node), name), liveControl(node));
    }
  }
}

/** The first movable row of each ordered list moved down, the second moved up. */
function addOrderControls(
  root: HTMLElement,
  controls: Map<string, PageControl>,
): void {
  for (const list of root.querySelectorAll<HTMLElement>(
    '[role="group"][aria-label]',
  )) {
    const label = list.getAttribute("aria-label");
    if (label === null) continue;
    const rows = [
      ...list.querySelectorAll<HTMLElement>("[data-sortable-id]"),
    ].filter(
      (candidate) =>
        candidate.closest('[role="group"]') === list &&
        candidate.querySelector(":scope > [data-row-line] [data-row-grip]") !==
          null,
    );
    rows.slice(0, 2).forEach((row, index) => {
      const grab = row.querySelector<HTMLElement>(
        ":scope > [data-row-line] [data-row-grab]",
      );
      const id = row.getAttribute("data-sortable-id");
      if (grab === null || id === null) return;
      controls.set(
        orderControl(label, id, index === 0 ? "down" : "up"),
        liveControl(grab),
      );
    });
  }
}

/** Opens every row's disclosure and the providers' Show all, until none is left closed. */
async function openEveryDisclosure(panel: SweepMount): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    const closed = [
      ...panel
        .root()
        .querySelectorAll<HTMLElement>(
          '[data-sortable-id] > [data-row-line] [aria-expanded="false"], button[aria-expanded="false"]',
        ),
    ].filter(
      (node) =>
        node.hasAttribute("data-row-grab") ||
        node.textContent.trim().startsWith("Show all providers"),
    );
    if (closed.length === 0) return;
    await panel.apply(() => {
      for (const node of closed) node.click();
    });
  }
}

/** What the page offers after `given`, from the shipped layout, everything open. */
async function pageAfter(
  panel: SweepMount,
  given: ReadonlyArray<SweepStep>,
): Promise<ReadonlyMap<string, PageControl>> {
  const context: SweepContext = {
    providerUsage: (providerId) =>
      panel.providerUsage().get(providerId) ?? null,
  };
  await panel.apply(() => {
    resetToShippedLayout();
  });
  for (const step of given) {
    await panel.apply(() => {
      step.run(context);
    });
  }
  await openEveryDisclosure(panel);
  return pageControls(panel.root());
}

/** Operates a page control the way a person does: a press, or Alt+Arrow on a row. */
async function operatePageControl(
  panel: SweepMount,
  key: string,
  node: HTMLElement,
): Promise<void> {
  await panel.apply(() => {
    if (key.startsWith("order|")) {
      node.focus();
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: key.endsWith("|down") ? "ArrowDown" : "ArrowUp",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      return;
    }
    node.click();
  });
}

/** The element an entry stands for on the page: its control, or a preset's card. */
function elementFor(
  panel: SweepMount,
  entry: SweepEntry,
  page: ReadonlyMap<string, PageControl>,
): { readonly key: string; readonly node: HTMLElement } | null {
  const control = entry.controls.at(0);
  if (control !== undefined) {
    const found = page.get(control);
    return found === undefined ? null : { key: control, node: found.node };
  }
  if (entry.source === "preset") {
    const card = panel
      .root()
      .querySelector<HTMLElement>(
        `[data-preset="${entry.id.slice("preset:".length)}"]`,
      );
    return card === null ? null : { key: entry.id, node: card };
  }
  return null;
}

function givenKey(entry: SweepEntry): string {
  return entry.given.map((step) => step.label).join(" > ");
}

const CENSUS_TIMEOUT_MS = 60_000;

describe("the plan is held to the registries and to the real page", () => {
  const plan = (): ReadonlyArray<SweepEntry> => runOf("sample").plan;
  const pages = new Map<string, ReadonlyMap<string, PageControl>>();
  let panel: SweepMount | null = null;

  beforeAll(async () => {
    const opened = await mountSweepSettingsPanel();
    panel = opened;
    const states = new Map<string, ReadonlyArray<SweepStep>>([["", []]]);
    for (const entry of plan()) states.set(givenKey(entry), entry.given);
    for (const [key, given] of states) {
      // Copied out: the elements are live, and only their keys are compared.
      pages.set(key, new Map(await pageAfter(opened, given)));
    }
  }, CENSUS_TIMEOUT_MS);

  afterAll(() => {
    panel?.unmount();
  });

  it("every settings definition is swept, a heading, or typed as not swept", () => {
    expect(Object.keys(DEFINITION_SWEEP).sort()).toEqual(
      [...definitionKeys()].sort(),
    );
    const covered = coveredIdentities(plan());
    const wrong: string[] = [];
    for (const key of definitionKeys()) {
      const answer = DEFINITION_SWEEP[key];
      const isCovered = covered.has(`definition:${key}`);
      const kind = LAYOUT.definitions[key].kind;
      if (answer.kind === "swept" && !isCovered)
        wrong.push(`${key}: swept, but no entry covers it`);
      if (answer.kind !== "swept" && isCovered)
        wrong.push(`${key}: ${answer.kind}, yet an entry covers it`);
      if (answer.kind === "heading" && kind !== "group")
        wrong.push(`${key}: a heading that is not a group`);
      if (answer.kind === "not-swept" && kind !== "row")
        wrong.push(`${key}: not swept, but it is a ${kind}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every arrangement field is swept or typed as not swept", () => {
    expect(Object.keys(ARRANGEMENT_SWEEP).sort()).toEqual(
      [...arrangementKeys()].sort(),
    );
    const covered = coveredIdentities(plan());
    const wrong: string[] = [];
    for (const key of arrangementKeys()) {
      const answer = ARRANGEMENT_SWEEP[key];
      const isCovered = covered.has(`arrangement:${key}`);
      if (answer.kind === "swept" && !isCovered)
        wrong.push(`${key}: swept, but no entry covers it`);
      if (answer.kind === "not-swept" && isCovered)
        wrong.push(`${key}: not swept, yet an entry covers it`);
    }
    expect(wrong).toEqual([]);
  });

  it("every region control the registry declares is covered or typed as not swept", () => {
    const covered = coveredIdentities(plan());
    const declared = registryIdentities();
    const untyped = declared.filter(
      (identity) =>
        !covered.has(identity) &&
        !NOT_SWEPT_REGION_CONTROLS.some((entry) => entry.identity === identity),
    );
    expect(untyped).toEqual([]);
    // And the plan names nothing the registry does not have.
    const phantom = [...covered].filter(
      (identity) =>
        /^(display|position-host|position-side|style|fine-tune|order|provider-display|provider-limits)/.test(
          identity,
        ) &&
        !declared.includes(identity) &&
        !NON_REGION_COVERS.includes(identity),
    );
    expect(phantom).toEqual([]);
    // Nothing is typed as not swept while a plan entry sweeps it.
    expect(
      NOT_SWEPT_REGION_CONTROLS.filter((entry) => covered.has(entry.identity)),
    ).toEqual([]);
    expect(Object.keys(GRAMMAR_ROW_SWEEP).length).toBeGreaterThan(0);
    expect(Object.keys(CONTROL_SPEC_SWEEP).length).toBeGreaterThan(0);
  });

  it("every control an entry stands for is on the real page, operable, in the state the entry puts it in", () => {
    const missing: string[] = [];
    for (const entry of plan()) {
      const page = pages.get(givenKey(entry));
      for (const control of entry.controls) {
        if (page?.get(control)?.live !== true)
          missing.push(`${entry.id}: ${control}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every control on the real page has an entry, or is typed as not swept", () => {
    const stoodFor = new Set(plan().flatMap((entry) => entry.controls));
    // A radio some state of the page draws as CHECKED is a value that state
    // starts from: seen from another state it is the way back to it, the mirror
    // of a write the plan already makes, not a control of its own. The shipped
    // page has no such allowance: everything live there is swept.
    const startingValues = new Set(
      [...pages.values()].flatMap((page) =>
        [...page].filter(([, control]) => control.checked).map(([key]) => key),
      ),
    );
    const unswept: string[] = [];
    for (const [state, page] of pages) {
      for (const [key, control] of page) {
        if (!control.live || stoodFor.has(key)) continue;
        if (state !== "" && startingValues.has(key)) continue;
        if (NOT_SWEPT_PAGE_CONTROLS.some((entry) => entry.matches(key)))
          continue;
        unswept.push(key);
      }
    }
    expect([...new Set(unswept)].sort()).toEqual([]);
  });

  it(
    "every writer the plan re-states writes exactly what the page's own control writes",
    async () => {
      const opened = panel;
      if (opened === null) throw new Error("the settings panel did not mount");
      const context: SweepContext = {
        providerUsage: (providerId) =>
          opened.providerUsage().get(providerId) ?? null,
      };
      const mirrored = plan().filter((entry) => entry.mirrors !== null);
      expect(mirrored.length).toBeGreaterThan(0);
      const differ: string[] = [];
      for (const entry of mirrored) {
        const page = await pageAfter(opened, entry.given);
        const target = elementFor(opened, entry, page);
        if (target === null) {
          differ.push(`${entry.id}: no control on the page to operate`);
          continue;
        }
        await operatePageControl(opened, target.key, target.node);
        const viaPage = JSON.stringify(getLayoutSnapshot());
        await opened.apply(() => {
          resetToShippedLayout();
        });
        for (const step of entry.given) {
          await opened.apply(() => {
            step.run(context);
          });
        }
        await opened.apply(() => {
          entry.write.run(context);
        });
        const viaPlan = JSON.stringify(getLayoutSnapshot());
        if (viaPage !== viaPlan) {
          differ.push(`${entry.id} (re-states ${entry.mirrors ?? ""})`);
        }
      }
      expect(differ).toEqual([]);
    },
    CENSUS_TIMEOUT_MS,
  );
});
