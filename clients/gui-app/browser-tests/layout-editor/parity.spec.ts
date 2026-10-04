import { expect, test } from "@playwright/test";

import { fixture, nextFrames } from "../support/fixtures.ts";
import { violationLog } from "../support/layout-editor/dom.ts";
import { layoutEditorUse, sharedPage } from "../support/layout-editor/pages.ts";
import { waitUntil } from "../support/layout-editor/waits.ts";

// THE LAYOUT EDITOR'S PARITY REGRESSION (P2, L-11, L-53).
//
// `layout-editor-browser.html` mounts the real leaves beside their pictures
// under the real stylesheet. Five claims, each a thing jsdom cannot decide:
//
//   1. The shipped stylesheet is actually in effect. Everything else is a
//      comparison of computed values, and comparisons of nothing agree.
//   2. Every region the fixture can mount LIVE without the host runtime is
//      compared with its picture, under the same host frame: the icon's
//      painted box and colour where the region draws one, its own resolved
//      `font-size` / `line-height` / `color` where it does not. Live versus
//      picture, never picture versus picture - the two picture entry points
//      became one function in L-77, so comparing them with each other could
//      not fail for any input (G3-02, L-85). Three live surfaces answer for
//      fifteen of the twenty regions: the sample rail (nine), the composer
//      toolbar in presentation mode (four, since L-136 retired the harness
//      label), and the dock's compact strip at Chip size (four, since L-98
//      put the sample workspace on the real dock and L-139 added Todo to it;
//      the Message queue is not a region since G1-G2).
//   3. The clipped Usage limits picture measures `data-clipped` and turns on
//      the mask that measurement asked for (LV2-14).
//   4. The attached dock panels, one one-line row each, are the same height
//      to the pixel (L-171).
//   5. The preset cards sit in one row in the 380px inspector; and the hover
//      chip is where the BROWSER painted it under CSS anchor positioning, not
//      where a measurement would have put it.
//
// Not here, because a jsdom test decides it: that every region row draws a
// depiction frame (`region-depiction-parity.test.tsx`, "a depiction draws the
// app's own leaf"), that a preset card holds one miniature above its name and
// caption (`presets-block.test.tsx`, "a preset card: one inert miniature"),
// and the fixture's own coverage tables (which regions have no live leaf and
// why) - a consistency check of the fixture against itself, which proves the
// fixture and not the product.

test.use(layoutEditorUse());

const page = sharedPage({
  path: fixture("layout-editor-browser"),
  ready: "window.__layoutEditorProbe?.ready === true",
  errorsGlobal: null,
});

/** A resolved reading off one node: an icon's box and colour, or a type scale and colour. */
type Reading = Readonly<Record<string, string | number>>;

interface LiveComparison {
  readonly regionId: string;
  readonly error: string | null;
  readonly live: Reading | null;
  readonly drawn: Reading | null;
}

/**
 * Every live region node the fixture mounted, beside its picture.
 *
 * The icon is the comparison wherever a region draws one - its painted box and
 * its resolved colour, which is what a wrong type scale or a wrong token moves.
 * A region that draws no icon is compared on its own type scale and colour
 * instead; its TEXT is not, because a picture is drawn from specimen data and
 * a live leaf from the app's, and P2 is about how a region looks rather than
 * what it currently says.
 */
const LIVE_PROBE = `(() => {
  const glyph = (node) => {
    const svg = node.querySelector("svg");
    if (svg === null) return null;
    const style = getComputedStyle(svg);
    const rect = svg.getBoundingClientRect();
    return {
      kind: "glyph",
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      color: style.color,
    };
  };
  const scale = (node) => {
    const style = getComputedStyle(node);
    return {
      kind: "scale",
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      color: style.color,
    };
  };
  const nodes = [...document.querySelectorAll("[data-live-surface] [data-layout-region]")];
  return nodes.map((node) => {
    const regionId = node.getAttribute("data-layout-region");
    const row = document.querySelector('[data-region-row="' + regionId + '"]');
    const picture = row === null
      ? null
      : row.querySelector("[data-layout-depiction]");
    if (picture === null) {
      return { regionId, error: "the fixture drew no picture for it", live: null, drawn: null };
    }
    // The depiction's OWN root, not the host frame around it: the frame
    // carries the surface's type scale, which is the thing the leaf inside it
    // is supposed to inherit rather than the thing being compared.
    const leaf = picture.firstElementChild ?? picture;
    const live = glyph(node) ?? scale(node);
    const drawn = live.kind === "glyph" ? glyph(leaf) : scale(leaf);
    // The sample sidebar always has one panel open, and its rail button wears
    // the rail's own current-panel ink. A picture is the button at rest, so
    // an open button is compared on its size only; the resting buttons beside
    // it carry the colour comparison.
    const current = node.matches('[aria-current="true"]') || node.querySelector('[aria-current="true"]') !== null;
    if (current && live !== null) delete live.color;
    if (drawn === null) {
      return { regionId, error: "the live leaf draws an icon and the picture does not", live, drawn: null };
    }
    return { regionId, error: null, live, drawn };
  });
})()`;

/**
 * Whether the shipped rules are in effect at all.
 *
 * Read off the two the rest of this file depends on: the passive dim's
 * opacity, which only `layout-editor.css` sets, and the ring's box-shadow,
 * which is three bands and would be `none` with no stylesheet.
 */
const STYLESHEET_PROBE = `(() => {
  const passive = document.querySelector("[data-layout-passive]");
  const ring = document.createElement("div");
  ring.setAttribute("data-layout-selection-ring", "");
  document.body.append(ring);
  const shadow = getComputedStyle(ring).boxShadow;
  ring.remove();
  const opacity = passive === null ? null : getComputedStyle(passive).opacity;
  return {
    loaded: opacity !== null && Number(opacity) < 1 && shadow !== "none",
    dimOpacity: opacity,
    ringShadow: shadow,
  };
})()`;

/**
 * The clipped Usage limits picture: what the frame MEASURED, and the mask the
 * measurement turned on.
 *
 * `webkitMaskImage` is read as well, because a Chrome that only supports the
 * prefixed property resolves the unprefixed one to the empty string - which is
 * the same shape as "no mask" and would read as the defect rather than as the
 * spelling.
 */
const CLIP_FADE_PROBE = `(() => {
  const frame = document.querySelector("#clip-fade [data-layout-depiction]");
  if (frame === null) return { error: "no [data-layout-depiction] inside #clip-fade" };
  const style = getComputedStyle(frame);
  const mask = style.maskImage === "" || style.maskImage === undefined
    ? style.webkitMaskImage
    : style.maskImage;
  return {
    error: null,
    clipped: frame.dataset.clipped ?? null,
    mask: mask ?? "",
    frameWidth: Math.round(frame.getBoundingClientRect().width),
    scrollWidth: frame.scrollWidth,
    clientWidth: frame.clientWidth,
  };
})()`;

/**
 * THE ONE ROW METRIC (L-171).
 *
 * The attached panels, one one-line row each, measured as the browser laid
 * them out. `min-h-8` on a shared row class, a `py-0.5`, a `size-6` control
 * and a floated toolbar are four things jsdom resolves to nothing, and the
 * defect they fix is a NUMBER: switching pills between two one-line panels
 * moved the composer's upper edge by 3.75px.
 *
 * The panel body is what the slot sizes itself to, so that is what is
 * measured - the list's own top and bottom inset included, since the ruling
 * binds the inset as much as the row.
 */
const DOCK_ROW_METRIC_PROBE = `(() => {
  // The recipe the page itself states, so a row is counted by the box it
  // claims rather than by a tag or a test id - the panels agree on neither. A
  // child count cannot stand in for it: the body's own first child is the
  // scroll box, so counting children reports the wrapper rather than the rows.
  const recipe = window.__layoutEditorProbe.dockRowRecipe;
  const sections = [...document.querySelectorAll("[data-dock-row-metric]")];
  const rows = sections.map((section) => {
    const body = section.querySelector("[data-testid='chat-dock-attached-panel']");
    const drawn =
      body === null
        ? null
        : [...body.querySelectorAll("*")].filter((node) =>
            recipe.every((token) => node.classList.contains(token)),
          ).length;
    return {
      section: section.getAttribute("data-dock-row-metric"),
      height: body === null ? null : body.getBoundingClientRect().height,
      rows: drawn,
    };
  });
  return { rows };
})()`;

/**
 * The attached panel list's own `py-1.5` inset at this fixture's root size,
 * which is what an EMPTY panel measures. A bare equality check passes on five
 * identical numbers, and five 11.25s - every panel drawing its inset and no
 * rows at all - are five identical numbers (R6H-04). So the shared height has
 * to clear the inset as well as be shared, and each panel has to have drawn
 * exactly the one row it was fed.
 */
const DOCK_ROW_METRIC_LIST_INSET = 11.25;

/**
 * The preset cards' layout: one row, however many there are. What a card
 * HOLDS is `presets-block.test.tsx`'s.
 */
const PRESET_CARDS_PROBE = `(() => {
  const cards = [...document.querySelectorAll('[data-testid="layout-presets-block"] [data-preset]')];
  const tops = cards.map((card) => Math.round(card.getBoundingClientRect().top));
  return { count: cards.length, oneRow: new Set(tops).size === 1 };
})()`;

const CHIP_PROBE = `(() => {
  const chip = document.querySelector("[data-layout-hover-chip]");
  const anchor = document.querySelector("[data-chip-anchor]");
  if (chip === null || anchor === null) return { error: "no chip or anchor" };
  const style = getComputedStyle(chip);
  const chipRect = chip.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  return {
    error: null,
    anchored: chip.getAttribute("data-anchored"),
    positionArea: style.positionArea ?? style.getPropertyValue("position-area"),
    margin: Number.parseFloat(style.marginBottom),
    gapBelow: anchorRect.top - chipRect.bottom,
    centreOffset:
      chipRect.left + chipRect.width / 2 - (anchorRect.left + anchorRect.width / 2),
  };
})()`;

test.beforeEach(async () => {
  // One frame for the page to settle before it is measured.
  await nextFrames(page(), 2);
});

test("the shipped layout-editor stylesheet is in effect", async () => {
  const stylesheet = await page().evaluate<{
    readonly loaded: boolean;
    readonly dimOpacity: string | null;
    readonly ringShadow: string;
  }>(STYLESHEET_PROBE);
  expect(
    stylesheet.loaded,
    `layout-editor.css is not in effect (${JSON.stringify(stylesheet)}); every comparison below would pass vacuously`,
  ).toBe(true);
});

test("every live region leaf resolves the same icon box, colour and type scale as its picture", async () => {
  const live = await page().evaluate<readonly LiveComparison[]>(LIVE_PROBE);
  expect(
    live.length,
    "no live region mounted, so nothing was compared",
  ).toBeGreaterThan(0);
  const violations = violationLog();
  for (const entry of live) {
    if (entry.error !== null || entry.live === null || entry.drawn === null) {
      violations.add(`${entry.regionId} live: ${String(entry.error)}`);
      continue;
    }
    for (const property of Object.keys(entry.live)) {
      if (property === "kind") continue;
      if (entry.live[property] !== entry.drawn[property]) {
        violations.add(
          `${entry.regionId} ${String(entry.live.kind)} ${property}: live ${String(entry.live[property])}, picture ${String(entry.drawn[property])}`,
        );
      }
    }
  }
  violations.assertNone("Layout editor parity regression failed");
});

test("the clipped Usage limits picture measures data-clipped and resolves a mask", async () => {
  // The clip fade on the one picture that can outgrow the inspector (LV2-14).
  // Six windowed providers, one of them running low and so expanded, in a
  // 292px stage is more than fits, and both halves
  // of the answer are real layout that jsdom cannot decide: the MEASURED
  // `data-clipped` (scrollWidth against clientWidth) and the `CLIP_FADE` mask
  // the attribute turns on.
  const clipFade = await page().evaluate<{
    readonly error: string | null;
    readonly clipped: string | null;
    readonly mask: string;
    readonly frameWidth: number;
    readonly scrollWidth: number;
    readonly clientWidth: number;
  }>(CLIP_FADE_PROBE);
  expect(clipFade.error, "clip fade: the fixture drew no clip case").toBeNull();
  expect(
    clipFade.clipped,
    `clip fade: every windowed provider in a ${String(clipFade.frameWidth)}px stage measured data-clipped="${String(clipFade.clipped)}" (content ${String(clipFade.scrollWidth)}px in ${String(clipFade.clientWidth)}px)`,
  ).toBe("true");
  expect(
    clipFade.mask === "none" || clipFade.mask === "",
    `clip fade: the clipped picture resolves no mask-image (got "${clipFade.mask}")`,
  ).toBe(false);
});

test("the attached dock panels share one row metric to the pixel", async () => {
  // Waited for rather than read straight off: two of them boot a host runtime
  // before they draw a row, so an unwaited read would measure the runtime's
  // fallback and call the nulls equal. The count is read off the page rather
  // than written down here, because a member is exactly the thing this file
  // should not be the register of.
  await waitUntil(
    page(),
    `document.querySelectorAll("[data-dock-row-metric] [data-testid='chat-dock-attached-panel']").length === document.querySelectorAll("[data-dock-row-metric]").length && document.querySelectorAll("[data-dock-row-metric]").length > 0`,
  );
  const dockRows = await page().evaluate<{
    readonly rows: ReadonlyArray<{
      readonly section: string;
      readonly height: number | null;
      readonly rows: number | null;
    }>;
  }>(DOCK_ROW_METRIC_PROBE);
  const report = dockRows.rows
    .map((row) => `${row.section} ${String(row.height)}px/${String(row.rows)}`)
    .join(", ");
  const heights = new Set(dockRows.rows.map((row) => row.height));
  const violations = violationLog();
  violations.check(
    heights.size === 1,
    `the attached dock panels do not share one row metric: ${report}`,
  );
  // Not vacuously: every panel drew the one row it was fed, and the shared
  // height is more than an empty list's inset.
  for (const row of dockRows.rows) {
    violations.check(
      row.rows === 1,
      `${row.section} drew ${String(row.rows)} rows, expected exactly 1: ${report}`,
    );
  }
  for (const height of heights) {
    violations.check(
      height !== null && height > DOCK_ROW_METRIC_LIST_INSET,
      `the attached dock panels measured ${String(height)}px, which is no more than an empty list's ${String(DOCK_ROW_METRIC_LIST_INSET)}px inset: ${report}`,
    );
  }
  violations.assertNone("Layout editor parity regression failed");
});

test("the preset cards sit in one row in the 380px inspector", async () => {
  const presetCards = await page().evaluate<{
    readonly count: number;
    readonly oneRow: boolean;
  }>(PRESET_CARDS_PROBE);
  expect(presetCards.count, "no preset cards rendered").toBeGreaterThan(0);
  expect(
    presetCards.oneRow,
    "preset cards wrap, expected one row at 380px",
  ).toBe(true);
});

test("the hover chip sits where Chrome's anchor positioning painted it", async () => {
  await page().evaluate("window.__layoutEditorProbe.showChip()");
  await waitUntil(
    page(),
    'document.querySelector("[data-layout-hover-chip]:not([hidden])") !== null',
  );
  await nextFrames(page(), 2);
  const chip = await page().evaluate<{
    readonly error: string | null;
    readonly anchored: string | null;
    readonly positionArea: string;
    readonly margin: number;
    readonly gapBelow: number;
    readonly centreOffset: number;
  }>(CHIP_PROBE);
  expect(chip.error, "hover chip: no chip or anchor").toBeNull();
  expect(
    chip.anchored,
    `hover chip took the measured fallback (data-anchored=${String(chip.anchored)}); this Chrome resolves no anchor positioning, so the painted position below proves nothing`,
  ).toBe("1");
  // Chrome serialises `block-start center` in its physical-agnostic short
  // form, so both spellings mean the rule in `layout-editor.css` took.
  expect(
    ["block-start center", "start center"],
    `hover chip position-area: expected the block-start centre area, got "${chip.positionArea}"`,
  ).toContain(chip.positionArea);
  // Painted, not computed: where Chrome actually put the box relative to the
  // element it is anchored to.
  expect(
    Math.abs(chip.gapBelow - chip.margin),
    `hover chip sits ${chip.gapBelow.toFixed(2)}px above its region, expected ${String(chip.margin)}px`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(chip.centreOffset),
    `hover chip is ${chip.centreOffset.toFixed(2)}px off its region's centre`,
  ).toBeLessThanOrEqual(1);
});
