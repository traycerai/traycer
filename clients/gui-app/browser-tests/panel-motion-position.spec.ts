import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture } from "./support/fixtures.ts";

// Floating surfaces (composer menu, mention preview, artifact-link popover,
// quote popover, profile sidecar, Radix popovers) must be PLACED at their
// anchor on mount and on every re-anchor, with no positional transition, while
// their enter/exit motion follows `--panel-animation-duration` and the two
// reduced-motion switches.
//
// jsdom cannot answer any of it. It has no layout, so `getBoundingClientRect`
// is all zeros and "the surface sits at its anchor" has no answer; it resolves
// no cascade, so the `transition-duration` / `animation-duration` a surface
// ends up with (a Tailwind utility, a `var(--panel-animation-duration)`, a
// `[data-reduce-panel-motion]` rule) are never computed; and it evaluates no
// media queries, so `prefers-reduced-motion` cannot be flipped. This drives the
// production surfaces (`QuoteSelectionPopover`, the Radix `Popover`) plus
// stand-ins for the slot-styled ones through Floating UI in a real layout
// engine and reads positions and computed motion back.
//
// The driver collected every violation across its phases into one list and
// asserted it empty. Each phase is now its own test and every check inside one
// is a soft assertion, so a red test still reports every surface that is off.

const SurfaceSchema = z.object({
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  transitionDuration: z.string(),
  transitionProperty: z.string(),
  animationDuration: z.string(),
  animationName: z.string(),
});
type Surface = z.infer<typeof SurfaceSchema>;

const PointSchema = z.object({ x: z.number(), y: z.number() });

const QuoteSchema = z.object({ surface: SurfaceSchema, anchor: PointSchema });
type Quote = z.infer<typeof QuoteSchema>;

const PopoverSchema = z.object({
  content: SurfaceSchema,
  wrapper: SurfaceSchema.nullable(),
  anchor: z.object({ x: z.number(), y: z.number(), bottom: z.number() }),
});
type Popover = z.infer<typeof PopoverSchema>;

const SnapshotSchema = z.object({
  anchor: PointSchema,
  transformSlots: z.record(z.string(), SurfaceSchema),
  sidecar: SurfaceSchema,
  editorBubble: SurfaceSchema,
  sheet: SurfaceSchema,
  sidebar: SurfaceSchema,
  drawer: SurfaceSchema,
  radixPopover: PopoverSchema,
  quotePopover: QuoteSchema,
});
type Snapshot = z.infer<typeof SnapshotSchema>;

const InitialSchema = z.object({
  initialTransformSlots: z.record(z.string(), SurfaceSchema),
  initialSidecar: SurfaceSchema,
  initialQuotePopover: QuoteSchema.nullable(),
});
type Initial = z.infer<typeof InitialSchema>;

// Where the fixture first anchors its Floating UI surfaces, and where
// `moveTo` re-anchors them. `y` is the anchor's y plus its 20px height plus the
// 4px `offset()` the fixture positions with.
const FIRST_ANCHOR = { x: 120.5, y: 204.25 } as const;
const REANCHOR_TARGET = { x: 440.25, y: 360.5 } as const;
const REANCHORED = { x: 440.25, y: 384.5 } as const;
const DEFAULT_MOTION_MS = 100;
const LONG_MOTION_MS = 800;

test.use({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });

async function openFixture(page: Page): Promise<void> {
  await page.goto(fixture("panel-motion-position"));
  await page.waitForFunction("window.__panelMotionProbe?.ready === true");
}

async function readSnapshot(page: Page): Promise<Snapshot> {
  return SnapshotSchema.parse(
    await page.evaluate("window.__panelMotionProbe.snapshot()"),
  );
}

async function readInitial(page: Page): Promise<Initial> {
  return InitialSchema.parse(
    await page.evaluate(
      `({ initialTransformSlots: window.__panelMotionProbe.initialTransformSlots,
          initialSidecar: window.__panelMotionProbe.initialSidecar,
          initialQuotePopover: window.__panelMotionProbe.initialQuotePopover })`,
    ),
  );
}

function near(label: string, actual: number, expected: number): void {
  expect
    .soft(
      Math.abs(actual - expected),
      `${label}: expected ${String(expected)}px, got ${String(actual)}px`,
    )
    .toBeLessThanOrEqual(1);
}

function durationMs(value: string): number | null {
  const magnitude = Number.parseFloat(value);
  if (!Number.isFinite(magnitude)) return null;
  if (value.endsWith("ms")) return magnitude;
  if (value.endsWith("s")) return magnitude * 1000;
  return null;
}

function duration(label: string, value: string, expectedMs: number): void {
  const actualMs = durationMs(value);
  expect
    .soft(
      actualMs !== null && Math.abs(actualMs - expectedMs) <= 1,
      `${label}: expected ${String(expectedMs)}ms, got ${value}`,
    )
    .toBe(true);
}

interface Anchor {
  readonly x: number;
  readonly y: number;
}

function verifyPosition(
  label: string,
  surface: Surface,
  target: Anchor,
  expectedTransitionMs: number | undefined,
): void {
  near(`${label} x`, surface.rect.x, target.x);
  near(`${label} y`, surface.rect.y, target.y);
  if (expectedTransitionMs !== undefined) {
    duration(
      `${label} transition`,
      surface.transitionDuration,
      expectedTransitionMs,
    );
  }
}

function verifyPositionSet(
  label: string,
  surfaces: Readonly<Record<string, Surface>>,
  target: Anchor,
  expectedTransitionMs: number | undefined,
): void {
  const slots = Object.entries(surfaces);
  expect(
    slots.length,
    `${label}: the fixture must expose transform slots to measure`,
  ).toBeGreaterThan(0);
  for (const [slot, surface] of slots) {
    verifyPosition(`${label} ${slot}`, surface, target, expectedTransitionMs);
    expect
      .soft(
        surface.transitionProperty,
        `${label} ${slot}: expected default transition-property all, got ${surface.transitionProperty}`,
      )
      .toBe("all");
  }
}

function verifyQuotePosition(label: string, quote: Quote | null): void {
  if (quote === null) {
    expect.soft(quote, `${label}: snapshot is missing`).not.toBeNull();
    return;
  }
  near(`${label} x`, quote.surface.rect.x, Math.round(quote.anchor.x));
  near(
    `${label} y`,
    quote.surface.rect.y,
    Math.round(quote.anchor.y - quote.surface.rect.height - 6),
  );
  duration(`${label} transition`, quote.surface.transitionDuration, 0);
}

function verifyPopoverWrapper(label: string, popover: Popover): void {
  const wrapper = popover.wrapper;
  if (wrapper === null) {
    expect
      .soft(wrapper, `${label}: Radix Popper wrapper snapshot is missing`)
      .not.toBeNull();
    return;
  }
  near(`${label} x`, wrapper.rect.x, popover.anchor.x);
  near(`${label} y`, wrapper.rect.y, popover.anchor.bottom + 4);
  duration(`${label} wrapper transition`, wrapper.transitionDuration, 0);
  expect
    .soft(
      popover.content.animationName,
      `${label}: expected the Radix open keyframe animation to remain active`,
    )
    .not.toBe("none");
}

function verifyMotionDurations(
  label: string,
  state: Snapshot,
  expectedMs: number,
): void {
  const animated: readonly (readonly [string, Surface])[] = [
    ...Object.entries(state.transformSlots).map(
      ([slot, surface]): readonly [string, Surface] => [
        `${slot} animation`,
        surface,
      ],
    ),
    ["profile sidecar animation", state.sidecar],
    ["editor bubble animation", state.editorBubble],
    ["Radix keyframe animation", state.radixPopover.content],
    ["quote keyframe duration", state.quotePopover.surface],
  ];
  for (const [name, surface] of animated) {
    duration(`${label} ${name}`, surface.animationDuration, expectedMs);
  }
  const positioned: readonly (readonly [string, Surface | null])[] = [
    ...Object.entries(state.transformSlots).map(
      ([slot, surface]): readonly [string, Surface | null] => [
        `${slot} position`,
        surface,
      ],
    ),
    ["profile sidecar position", state.sidecar],
    ["editor bubble position", state.editorBubble],
    ["quote popover position", state.quotePopover.surface],
    ["Radix Popper wrapper position", state.radixPopover.wrapper],
  ];
  for (const [name, surface] of positioned) {
    if (surface !== null) {
      duration(`${label} ${name} transition`, surface.transitionDuration, 0);
    }
  }
  const eased: readonly (readonly [string, Surface])[] = [
    ["sheet transition", state.sheet],
    ["sidebar transition", state.sidebar],
    ["drawer transition", state.drawer],
  ];
  for (const [name, surface] of eased) {
    duration(`${label} ${name}`, surface.transitionDuration, expectedMs);
  }
}

// ── Placement on mount ────────────────────────────────────────────────────

test("first Floating UI placement puts every transform slot on its anchor", async ({
  page,
}) => {
  await openFixture(page);
  const initial = await readInitial(page);
  verifyPositionSet(
    "first Floating UI placement",
    initial.initialTransformSlots,
    FIRST_ANCHOR,
    undefined,
  );
});

test("first placement carries no transition duration, on the slots or the sidecar", async ({
  page,
}) => {
  await openFixture(page);
  const initial = await readInitial(page);
  verifyPositionSet(
    "first placement transition duration",
    initial.initialTransformSlots,
    FIRST_ANCHOR,
    0,
  );
  verifyPosition(
    "first sidecar transition duration",
    initial.initialSidecar,
    FIRST_ANCHOR,
    0,
  );
});

test("first sidecar placement lands on its anchor", async ({ page }) => {
  await openFixture(page);
  const initial = await readInitial(page);
  verifyPosition(
    "first sidecar placement",
    initial.initialSidecar,
    FIRST_ANCHOR,
    undefined,
  );
});

test("the QuoteSelectionPopover's first placement lands on its anchor", async ({
  page,
}) => {
  await openFixture(page);
  const initial = await readInitial(page);
  expect(
    initial.initialQuotePopover,
    "QuoteSelectionPopover did not expose its first transform placement",
  ).not.toBeNull();
  verifyQuotePosition(
    "first QuoteSelectionPopover placement",
    initial.initialQuotePopover,
  );
});

test("the Radix Popover's first placement sits under its anchor", async ({
  page,
}) => {
  await openFixture(page);
  const snapshot = await readSnapshot(page);
  verifyPopoverWrapper("first Radix Popover placement", snapshot.radixPopover);
});

// ── Motion durations follow the CSS variable and the reduced-motion switches ─

test("with no override, animations run the default 100ms and every positioned surface has no transition", async ({
  page,
}) => {
  await openFixture(page);
  verifyMotionDurations("default", await readSnapshot(page), DEFAULT_MOTION_MS);
});

test("--panel-animation-duration sets the animation and easing durations", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(
    `document.documentElement.style.setProperty("--panel-animation-duration", "800ms")`,
  );
  verifyMotionDurations("long", await readSnapshot(page), LONG_MOTION_MS);
});

test("the app's reduced-panel-motion switch zeroes every duration", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(
    `document.documentElement.setAttribute("data-reduce-panel-motion", "")`,
  );
  verifyMotionDurations("app reduced motion", await readSnapshot(page), 0);
});

test("the OS prefers-reduced-motion setting zeroes every duration", async ({
  page,
}) => {
  await openFixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  verifyMotionDurations("OS reduced motion", await readSnapshot(page), 0);
});

test("removing the override restores the default duration", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(
    `document.documentElement.style.setProperty("--panel-animation-duration", "800ms")`,
  );
  // The override must have taken before its removal means anything.
  expect(
    (await readSnapshot(page)).sheet.transitionDuration,
    "the override must be in effect before it is removed",
  ).toBe("0.8s");
  await page.evaluate(
    `document.documentElement.style.removeProperty("--panel-animation-duration")`,
  );
  verifyMotionDurations(
    "restored default",
    await readSnapshot(page),
    DEFAULT_MOTION_MS,
  );
});

// ── Re-anchoring ──────────────────────────────────────────────────────────

/**
 * Moves every anchor. The Floating UI slots and the sidecar are positioned by
 * `moveTo` itself, so they are read the moment it returns: a positional
 * transition would leave them mid-flight. The Radix popover and the quote
 * popover re-anchor in response to the resize `moveTo` dispatches, so they get
 * there a little later; `waitForFollowers` waits for THEM to arrive, and their
 * transition durations are asserted separately, which is what makes the
 * arrival immediate.
 */
async function moveAnchors(page: Page): Promise<void> {
  await page.evaluate(
    `window.__panelMotionProbe.moveTo(${String(REANCHOR_TARGET.x)}, ${String(REANCHOR_TARGET.y)})`,
  );
}

async function waitForFollowers(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await readSnapshot(page);
        const wrapper = snapshot.radixPopover.wrapper;
        return (
          wrapper !== null &&
          Math.abs(wrapper.rect.x - REANCHORED.x) <= 1 &&
          Math.abs(snapshot.quotePopover.surface.rect.x - REANCHORED.x) <= 1
        );
      },
      {
        message:
          "the Radix popover and the QuoteSelectionPopover must follow a re-anchor",
      },
    )
    .toBe(true);
}

test("an immediate Floating UI re-anchor moves every transform slot with no transition", async ({
  page,
}) => {
  await openFixture(page);
  await moveAnchors(page);
  const reanchored = await readSnapshot(page);
  verifyPositionSet(
    "immediate Floating UI re-anchor",
    reanchored.transformSlots,
    REANCHORED,
    undefined,
  );
  verifyPositionSet(
    "re-anchor transition duration",
    reanchored.transformSlots,
    REANCHORED,
    0,
  );
});

test("an immediate sidecar re-anchor moves it with no transition", async ({
  page,
}) => {
  await openFixture(page);
  await moveAnchors(page);
  const reanchored = await readSnapshot(page);
  verifyPosition(
    "immediate sidecar re-anchor",
    reanchored.sidecar,
    REANCHORED,
    undefined,
  );
  verifyPosition(
    "sidecar re-anchor transition duration",
    reanchored.sidecar,
    REANCHORED,
    0,
  );
});

test("the Radix Popover follows a re-anchor", async ({ page }) => {
  await openFixture(page);
  await moveAnchors(page);
  await waitForFollowers(page);
  verifyPopoverWrapper(
    "re-anchored Radix Popover",
    (await readSnapshot(page)).radixPopover,
  );
});

test("the QuoteSelectionPopover follows a re-anchor", async ({ page }) => {
  await openFixture(page);
  await moveAnchors(page);
  await waitForFollowers(page);
  verifyQuotePosition(
    "re-anchored QuoteSelectionPopover",
    (await readSnapshot(page)).quotePopover,
  );
});
