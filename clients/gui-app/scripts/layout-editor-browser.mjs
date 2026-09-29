// THE LAYOUT EDITOR'S PARITY REGRESSION (P2, L-11, L-53).
//
// Run it with one command, from `clients/gui-app`:
//
//     bun scripts/layout-editor-browser.mjs
//
// It serves `src/__tests__/browser/layout-editor-browser.html` from this
// package's own Vite config (which is what compiles Tailwind for the fixture -
// without it every utility class is present with no rule behind it and every
// geometric claim below passes vacuously), drives headless Chrome over CDP,
// and shuts both down in `finally`. Set `CHROME_BIN` if Chrome is somewhere
// non-standard.
//
// Four claims, each a thing jsdom cannot decide:
//
//   1. Every region the fixture can mount LIVE without the host runtime is
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
//   2. The coverage is stated rather than counted: every region with no live
//      node here must be named in the fixture's `NO_LIVE_LEAF` table with the
//      reason, and every region that HAS one must not be. The driver prints
//      the uncovered list so the gap is visible in the output.
//   3. The preset cards sit in one row in the 380px inspector, each with one
//      miniature on top and its name and caption below.
//   4. The hover chip is where the BROWSER painted it under CSS anchor
//      positioning, not where a measurement would have put it.
//
// A fifth, first: the shipped stylesheet is actually in effect. Everything
// else is a comparison of computed values, and comparisons of nothing agree.
//
// ---------------------------------------------------------------------------
// PHASE 2: THE CANVAS INTERACTION REGRESSION (L-115 .. L-135)
//
// The same command then navigates the same Chrome to
// `src/__tests__/browser/layout-editor-canvas.html` and drives the real sample
// scene, inside the real app column, beside the real editor, with REAL mouse
// input (`Input.dispatchMouseEvent`). It exists because three review gates and
// thousands of jsdom tests passed while that scene was wrapped in `inert`:
// jsdom has no hit testing, no layout and no paint order, so nothing below is
// decidable there.
//
//   A3. A real `mouseMoved` onto every region's centre stamps `data-hover` and
//       raises the name chip, so nothing (`inert`, an overlay, a sibling) sits
//       over it where it takes input.
//   A4. A real click selects, opens that region's inspector section, and the
//       APP does not act: no menu, no popover, no file chooser, no panel
//       toggled.
//   A5. Seven real drags - a compact pill, a full dock row, a toolbar member
//       each way (the leftward one past the cluster's narrow leading member,
//       L-143), a rail icon across a divider, a rail DIVIDER, and the clamp -
//       each read back off the layout store as exactly one history step, with
//       `[data-layout-dragging]` and a reflowing sibling measured mid-gesture.
//   A6. Microphone Hidden removes its box, and its ghost comes back under a
//       real hover on the inspector's index row.
//   A7. A Hidden + Chip dock member ghosts as a PILL, not as the row it never
//       takes at rest.
//   A8. A real right-click opens the quick-verb menu on a region inside a
//       session and at rest - the dock's rows, the sample rail's icons and the
//       minimap included (L-144), each naming its region - and opens nothing
//       on the sample transcript's prose.
//   A9. The editing frame is counted in PIXELS off a screenshot, within 3 CSS
//       px of each of the column's four edges, in all three dock modes -
//       including the top edge under the opaque positioned header, which is
//       the exact place the pre-L-130 outline was painted under (LV2-04). Its
//       inset and radius are asserted against L-137's numbers rather than
//       merely read, and each of the four corners is checked for the square
//       join an arc cannot draw.
//
// The canvas fixture mounts the shell's own `AppColumnFrame`; A3-A9 run it at
// the `top` placement. The selection ring's painted box is the switch phase's
// (A14) and the groups phase's (clamped at the window's edge).
//
// ---------------------------------------------------------------------------
// THE SIDE TAB STRIP (specs/side-tabs, ticket 12)
//
// Every variant below is a fresh navigation with its own query, and the
// page-load guard re-baselines per variant.
//
//   Phase 2b (sides), `layout-editor-canvas.html?tabs=&collapsed=&wco=&dock=`
//       with the real `SideTabStrip` and `DesktopMenuHeader` band:
//       A9 generalised - the editing frame on all four column edges with no
//       header, and the session row's solid `--warning-foreground` fill with
//       `--background` text (L-163), sampled in pixels.
//       A11 - every strip part (top block, Home, a row, the active close, the
//       foot, the handle) is the hit target at its centre; a right strip sits
//       left of a right-docked inspector; with the inspector docked left on
//       macOS its header keeps the 82px inset and the strip's title row 12px.
//       A12 - the rail is 60px (at least 82px on macOS with the strip at the
//       left) with 40x44 tiles, each a 26x22 monogram chip over its meter; an
//       active tile's rim changes fill and its chip keeps its tint in both
//       themes.
//       A13 - the band per platform (40px, strip top at its bottom, hidden in
//       macOS fullscreen), the 40px title row where the strip owns the title
//       bar, the surface frame flush under the band or the window top, and the
//       dialog overlay's top under `.wco`.
//       Row kit - the 10px badge on a 20x16 leading monogram tile, and the group line as
//       one continuous line across its members.
//   Phase 2c (switch). A14 - a real click on Position "Left" moves the strip in
//       one frame as one history step; one undo restores the top, with the
//       selection ring heading for the moved node at once.
//   Phase 3 (strip), `side-tab-strip.html?edge=left|right`: real-mouse y
//       reorder with a neighbour stepping aside, a drop on a row's half that
//       pairs two tabs, a split dragged whole, the tear-off preview and the
//       new-window request 30px into the content, and none toward the window
//       edge until the pointer leaves the viewport.
//
// ---------------------------------------------------------------------------
// THE SHEET SHELL (specs/sidebar-redesign, ticket 07)
//
// `layout-editor-canvas.html` with `surface=epic` (a task's panel and content
// sheets, the real width handle between them), `sidebar=`, `view=` and
// `account=1`:
//
//   sheets - flush surface (ticket 09): the frame flush on every side (no
//       shell gap, no padding, no margin), the panel with no border of its
//       own, the canvas frame's border suppressed only on the edge that
//       already carries the surface's own seam line, no radius or
//       pseudo-element arc left anywhere, and both width handles as the hit
//       at the flush boundaries; left/right x none/macOS and top.
//   header - `header=app` at the top (staging round 1, F4; flush surface,
//       ticket 09): the active tab, the split pair's focused member and both
//       drag overlays are one 32px box (its own rounding, self-consistent on
//       all four corners), centred in the header, with ground under it and
//       nothing of the strip below the header; the surface frame sits flush
//       against the header's own bottom edge. No controls, macOS and
//       Windows, panel on either side, in both themes.
//   running - the glyph set's running state is AgentSpinningDots' default
//       dots on the expanded strip and the top header (F3): advancing under an emulated `no-preference`, one steady visible frame
//       with an unchanged status name under `reduce`; the collapsed rail shows
//       the same work as meter turn pips with no spinner.
//   join - the active row and tile take the panel's fill across the gap and
//       over the sheet's border, with ground past the concave corners; nothing
//       joins on the far side or over a route surface; the bridge holds over
//       the hovered resize handle and after a reorder settles, and gives way
//       while its row is cut by the list's edge.
//   flip - F2: across a live panel side change, and on load, the panel sits
//       flush against the content frame and the hosted chat body stays on its
//       slot inside it, never over the panel.
//   moves - the same after every other live change that moves the content:
//       a strip side switch, top to side and back, a strip collapse, a real
//       width drag, the panel collapsing to its rail.
//   rail - 60px, each tile's badge kind as a 14px disc at the top-right; the
//       waiting pulse painted past the last row with the list's padding
//       holding its 8px spread.
//   overlays - the hover card and the Notifications drawer (flush with the
//       frame) open toward the content and inside the window, on both edges.
//   readings - the strip foot's readings row: two readings split it in half,
//       one takes all of it, collapsed they stack as 40px tiles, no reading is
//       ever drawn cut, and each popover opens toward the content.
//   hostmenu - the account menu opens on one click toward the content, inside
//       the window and at most 256px wide, and a long host name truncates and
//       reads in full from its tooltip.
//   activity - the live agents under the active row in the Activity view,
//       inside the strip, each title one 16px indent step per level.
//   striptop - the top block (F1, F7), left/right x none/macOS x rail/expanded:
//       the rail as one column (the lights on macOS left, expand,
//       Notifications, All tasks, New Task, a divider, Home, the tiles, the avatar),
//       every part centred on the rail's axis, 32px nav tiles 4px apart, the
//       divider midway, Home and the tiles evenly spaced;
//       expanded, New Task after Home in Home's box with its icon and label
//       level with Home's; New Task filled with the primary colour and the
//       divider readable, in both themes.
//   stripresize - F9: a real drag on the strip's handle across the snap point
//       switches the layout (tiles or rows, the top block, the joined item,
//       the Activity view's live agents) with the pointer still down, both
//       ways and on both edges, and the store is written once, on release;
//       the crossing eases, and Escape or a release lands at once.
//   placement - the tab strip and the sample sidebar selected by their own
//       space, the placement bar beside them, a pictogram writing the edge, and
//       a real drag lighting the zones and writing the edge it is dropped on.
//   groups - a stacked pair on the panel rail is one icon with no card, its
//       count painted on it while editing, the ring clamped onto it inside the
//       window, its row's Enter and Space by real keys, and a divider moved by
//       real drags and keys.
//
// Set LAYOUT_EDITOR_BROWSER_SHOTS to a directory to keep those phases'
// screenshots.
//
// What these fixtures cannot mount (native controls, real `env()` values,
// `-webkit-app-region`, the menu bar's popups, the real notification feed,
// guest browser views) is the Staging checklist's: specs/side-tabs/tickets/12
// and specs/sidebar-redesign/tickets/07.
//
// Set LAYOUT_EDITOR_BROWSER_PHASES to a comma list of parity, canvas, sides,
// switch, strip, sheets, header, running, flip, moves, join, rail, striptop,
// stripresize, overlays, readings, hostmenu, activity, placement, groups to run
// only those while iterating; every selected phase runs even after one fails, and
// the run fails if any did.
//
// Set LAYOUT_EDITOR_BROWSER_SHARD to k/n to run the k-th of n contiguous slices
// of the phase list, balanced by each phase's measured CI time (see
// `PHASE_CI_SECONDS`). CI runs the driver as n parallel jobs this way
// (`run-browser-regressions.ts`); the slices cover every phase exactly once,
// a phase added later included. It cannot be combined with
// LAYOUT_EDITOR_BROWSER_PHASES.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./chrome-launcher.mjs";
import { openTabSession } from "./cdp-client.mjs";

// --- page-side probes -------------------------------------------------------

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

const PICTURE_PROBE = `(() => {
  return [...document.querySelectorAll("[data-region-row]")].map((row) => ({
    regionId: row.getAttribute("data-region-row"),
    framed: row.querySelector("[data-layout-depiction]") !== null,
  }));
})()`;

const COVERAGE_PROBE = `(() => ({
  regionIds: window.__layoutEditorProbe.regionIds,
  noLiveLeaf: window.__layoutEditorProbe.noLiveLeaf,
}))()`;

/**
 * The clipped Usage limits picture: what the frame MEASURED, and the mask the
 * measurement turned on.
 *
 * \`webkitMaskImage\` is read as well, because a Chrome that only supports the
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
 * The preset cards: one row, each with exactly one miniature above its name
 * and caption.
 */
const PRESET_CARDS_PROBE = `(() => {
  const cards = [...document.querySelectorAll('[data-testid="layout-presets-block"] [data-preset]')];
  const tops = cards.map((card) => Math.round(card.getBoundingClientRect().top));
  return {
    count: cards.length,
    oneRow: new Set(tops).size === 1,
    unpictured: cards.filter((card) => card.querySelectorAll('[data-testid="preset-miniature"]').length !== 1).map((card) => card.getAttribute("data-preset")),
    untitled: cards.filter((card) => card.textContent.trim().length === 0).map((card) => card.getAttribute("data-preset")),
  };
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
 * THE ONE ROW METRIC (L-171).
 *
 * Five attached panels, one one-line row each, measured as the browser laid
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
  // claims rather than by a tag or a test id - the four panels agree on
  // neither. A child count cannot stand in for it: the body's own first child
  // is the scroll box, so counting children reports the wrapper rather than
  // the rows.
  const recipe = window.__layoutEditorProbe.dockRowRecipe;
  const sections = [...document.querySelectorAll("[data-dock-row-metric]")];
  const rows = sections.map((section) => {
    const body = section.querySelector(
      "[data-testid='chat-dock-attached-panel']",
    );
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
 * The list's own `py-1.5` inset, which is what an EMPTY panel measures.
 *
 * A bare equality check passes on five identical numbers, and five 11.25s -
 * every panel drawing its inset and no rows at all - are five identical
 * numbers (R6H-04). So the shared height has to clear the inset as well as
 * be shared, and each panel has to have drawn exactly the one row it was fed.
 */
const DOCK_ROW_METRIC_LIST_INSET = 11.25;

// --- phase 2: canvas-interaction constants ---------------------------------

/** `selection-ring.ts`'s own two numbers, restated so a drift is a failure. */
const RING_PADDING = 3;
const RING_BLEED = 6;

/**
 * `selection-ring.ts`'s own `insideWindow`, restated: a target within
 * {@link RING_BLEED} of the viewport edge is clamped so the halo the ring
 * paints outside its own box is never itself clipped. A region near an edge
 * (the rail's top row, for one) is expected on this clamped box, not the raw
 * padded one.
 */
function clampedRingBox(box, viewport) {
  const left = Math.max(box.x, RING_BLEED);
  const top = Math.max(box.y, RING_BLEED);
  const right = Math.min(box.x + box.width, viewport.width - RING_BLEED);
  const bottom = Math.min(box.y + box.height, viewport.height - RING_BLEED);
  if (right <= left || bottom <= top) return box;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The window the editing frame's stroke is looked for in, across each edge.
 *
 * The frame is held `--layout-editor-frame-inset` inside the column and
 * rounded by `--layout-editor-frame-radius`, both read at run time: where the
 * stylesheet puts the stroke is a design decision, and a driver that kept
 * scanning the outermost four pixels reported a deliberate 4px inset as four
 * unlit edges (measured, 0 of 1180 on every one of twelve edges). The window
 * is wider than the 2px border on purpose - what is being asserted is that the
 * edge is LIT near the inset, not that it is a CSS border, so the same count
 * survives the stroke becoming an SVG or a shadow.
 */
const FRAME_BAND_BEFORE_INSET = 2;
const FRAME_BAND_AFTER_INSET = 6;

/**
 * L-137's two numbers, stated here so that reading them is not the same as
 * accepting them.
 *
 * A9 counts each edge AT the inset the column reports, which is what lets one
 * count describe all three dock modes without restating the stylesheet. The
 * cost is that the count moves with the value: a frame that regressed to
 * `inset: 0` with square corners - which is exactly what the owner's fourth
 * live pass believed it was looking at - would be counted at zero and pass
 * every edge, because a stroke flush with the window edge is still a stroke.
 * So the value is asserted as well as read. The pixels below then answer the
 * other half, which no computed style can: whether the CORNERS are drawn on
 * the radius the stylesheet declares.
 */
const DESIGNED_FRAME_INSET = 4;
const DESIGNED_FRAME_RADIUS = 12;

/**
 * The square of pixels a SQUARE corner would light and a rounded one cannot.
 *
 * Centred on the frame's own rectangle corner, `(inset, inset)` in the
 * column's coordinates. With `border-radius: r`, the stroke's outer edge near
 * that corner is the arc centred at `(inset + r, inset + r)` with radius `r`,
 * and every point of this box is further from that centre than `r` - the
 * nearest, `(inset + 2, inset + 2)`, by 14.1 against 12 - so the designed
 * frame provably leaves it dark no matter where the dot phase falls. A square
 * corner puts its mitre join exactly there. The assertion is therefore in the
 * safe direction: it can only fire on ink the design cannot produce.
 */
const FRAME_CORNER_PROBE = 4;

/**
 * The share of an edge's straight run that a DOTTED stroke lights, as this
 * count can see it.
 *
 * A 2px dotted border repeats every 4px, so the design duty cycle is a half.
 * What the count measures is narrower than that: a position is lit when some
 * pixel in the band is within tolerance of pure amber, and whether a dot's
 * 2px disc covers one pixel fully or two pixels at 77% is decided by where
 * that dot's centre falls on the pixel grid. Chromium distributes the dots
 * along the WHOLE rounded border path, so each side starts at its own
 * sub-pixel phase, and the same one stylesheet rule measures 50.0% on the top
 * edge and 25.0% on the other three (measured, all three dock modes). Neither
 * number is a fact about the design, so the band is set where it separates
 * the three things that ARE: an edge that is missing or painted over reads 0%
 * (the inset bug this count was added for measured exactly that), a SOLID
 * stroke reads 100%, and a dotted one lands between.
 */
const FRAME_LIT_FLOOR = 0.15;
const FRAME_LIT_CEILING = 0.8;

/**
 * The same question asked of each QUARTER of an edge's straight run.
 *
 * The band above cannot fail for a HALF-covered edge, which is the defect the
 * frame was rebuilt for (L-130): an edge that loses 40% of its lit positions
 * to an opaque descendant still lands inside 15-80%. An opaque child covers a
 * CONTIGUOUS stretch, so it empties whole quarters; a stroke that is merely
 * phased differently does not, because the dot pitch is 4px and a quarter of
 * the shortest edge is far longer than that.
 *
 * Floored well under the measured 25% baseline (50% on the top edge) rather
 * than beside it, because a quarter is a quarter of the sample and the phase
 * is decided per edge by where the rounded path's dots land.
 */
const FRAME_QUARTER_LIT_FLOOR = 0.1;

/**
 * How far past a neighbour's centre a drag is aimed.
 *
 * `drag-engine.ts` takes its grab point at the move that CROSSES the 6px
 * activation distance rather than at the press, so the effective travel is six
 * pixels less than the pointer's. Aiming six past a centre therefore lands
 * exactly ON it, where the comparison is strict and the member keeps its own
 * slot. Measured: the rail's two drags wrote nothing for exactly that reason.
 * Eighteen leaves twelve pixels of margin.
 *
 * What the overshoot is measured ON changed with L-143: `drag-model.ts` now
 * claims a slot once the dragged member's LEADING EDGE in the direction of
 * travel passes the neighbour's centre, not once its own centre does. A plan
 * whose anchor is smaller than the member it drags therefore sets
 * `leadingEdge`, and the pointer is placed so that EDGE lands the overshoot
 * past the anchor - otherwise a 36px rail icon aimed 18px past an 8px divider
 * carries its top edge 44px, which is past the panel above the divider as
 * well, and one gesture claims two slots.
 *
 * `drag-model.ts` also floors the travel a claim needs at 12px (L-150(4)), so
 * every plan below has to clear that as well as the claim boundary itself.
 * The two rail plans are the tight ones and both do, on the rail's measured
 * geometry: the Agents group 0..36 (a stacked pair draws one icon, G3), a 4px
 * gap, the 8px divider at 40..48, a 4px gap, Terminals 52..88.
 * "Rail icon across a divider" aims Terminals' top edge at 44 - 18 = 26 and
 * places the pointer half a member behind it, at 44, so the pointer travels
 * 70 - 44 = 26 and the member travels 26 - 6 = 20. "Rail divider itself"
 * aims the 8px divider's centre at 70 + 18 = 88, so the pointer travels 44
 * and the member 38. Every other plan passes an ordinary neighbour, whose own
 * boundary is already above the floor.
 */
const DROP_OVERSHOOT = 18;

/**
 * Regions the sample scene draws, in the order the assertions walk them. The
 * three it does not draw are named by the fixture, with a reason each, and the
 * driver checks that list against this one rather than trusting either.
 *
 * Intersected with the product's own `LAYOUT_REGION_IDS` at run time (see
 * `mountedRegions`), so a region the app retires stops being asserted here
 * instead of failing as "no node on the canvas" - and a region the app ADDS
 * still fails the coverage cross-check below, which is the direction that
 * needs to be loud.
 */
const CANVAS_REGIONS = [
  "railAgents",
  // railArtifacts: drawn inside Agents' group icon (G3); the fixture excuses it.
  "railTerminals",
  "railBrowsers",
  "railGitDiff",
  "railPullRequests",
  "railFileTree",
  "railSharing",
  "railComments",
  "minimap",
  // The sample conversation's own regions (L-175, L-178): a reasoning-only
  // activity row and a command row in its last two turns, and a stamp on
  // every prompt.
  "toolActivity",
  "thinking",
  "timestamps",
  "contextUsage",
  "changedFiles",
  "runningAgents",
  "background",
  "todo",
  "attachImage",
  "access",
  "model",
  "mic",
];

/**
 * Everything the amber-frame count needs, installed once per page: the token's
 * PAINTED colour, sampled through the same screenshot pipeline the edges are
 * counted in rather than parsed out of a computed style (`--warning-foreground`
 * is an `oklch()` behind a `light-dark()` in some themes, and a parse that
 * silently produced black would make every edge below read as unlit), and a
 * decoder that turns a clipped screenshot back into pixels with a canvas.
 */
const INSTALL_PIXEL_TOOLS = `(() => {
  // Decoded in the PAGE rather than in the driver: a screenshot is a PNG, and
  // the only zlib-and-unfilter this scenario is allowed to add is the one the
  // browser already has. The counting happens in the same call so the pixels
  // never cross the wire.
  const decode = async (base64) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve);
      image.addEventListener("error", () => reject(new Error("screenshot decode failed")));
      image.src = "data:image/png;base64," + base64;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  };
  window.__samplePixel = async (base64) => {
    const shot = await decode(base64);
    if (shot.width === 0) return null;
    return [shot.data[0], shot.data[1], shot.data[2]];
  };
  window.__regionPixels = async (base64) => {
    const shot = await decode(base64);
    const rgb = [];
    for (let i = 0; i < shot.data.length; i += 4) rgb.push(shot.data[i], shot.data[i + 1], shot.data[i + 2]);
    return rgb;
  };
  window.__countShot = async (base64, horizontal, target, tolerance) => {
    const shot = await decode(base64);
    return window.__countLit(shot, horizontal, target, tolerance);
  };
  window.__swatch = (on) => {
    const existing = document.querySelector("[data-amber-swatch]");
    if (existing !== null) existing.remove();
    if (!on) return null;
    const node = document.createElement("div");
    node.setAttribute("data-amber-swatch", "");
    node.style.position = "fixed";
    node.style.left = "600px";
    node.style.top = "600px";
    node.style.width = "12px";
    node.style.height = "12px";
    node.style.zIndex = "2147483000";
    node.style.background = "var(--warning-foreground)";
    document.body.append(node);
    return { left: 600, top: 600 };
  };
  window.__countLit = (shot, horizontal, target, tolerance) => {
    const { width, height, data } = shot;
    const along = horizontal ? width : height;
    const across = horizontal ? height : width;
    let lit = 0;
    // Also per QUARTER of the run: one number for a whole edge cannot fail
    // for an edge that is half covered, which is the defect class the frame
    // was rebuilt for (L-130, R4B-07).
    const quarters = [0, 0, 0, 0];
    const quarterAlong = [0, 0, 0, 0];
    for (let a = 0; a < along; a += 1) {
      let hit = false;
      for (let b = 0; b < across && !hit; b += 1) {
        const x = horizontal ? a : b;
        const y = horizontal ? b : a;
        const i = (y * width + x) * 4;
        const distance =
          Math.abs(data[i] - target[0]) +
          Math.abs(data[i + 1] - target[1]) +
          Math.abs(data[i + 2] - target[2]);
        if (distance <= tolerance && data[i + 3] > 200) hit = true;
      }
      const quarter = Math.min(3, Math.floor((a * 4) / Math.max(1, along)));
      quarterAlong[quarter] += 1;
      if (hit) {
        lit += 1;
        quarters[quarter] += 1;
      }
    }
    return {
      lit,
      along,
      quarters: quarters.map((count, index) => ({
        lit: count,
        along: quarterAlong[index],
      })),
    };
  };
})()`;

/**
 * Whether the APP acted, read either side of a click (4.4).
 *
 * A swallowed click leaves nothing behind, so the proof has to be that every
 * observable the app's own controls move is unchanged: the open/closed state
 * of every disclosure inside the column, and the number of menu, dialog and
 * popover layers anywhere. The file chooser is the one the DOM cannot answer;
 * that one is a CDP event.
 */
// The sample sidebar's body is left out: it shows the panel of the selected
// Sidebar setting by design (F3), so a click that selects a rail icon swaps
// its sections without the app having acted. So is the sample model picker,
// which the editor opens while Model is selected so its footer has something
// to show: it is the editor's picture, not a popover the app opened.
const APP_ACTED_PROBE = `(() => {
  const column = document.querySelector("[data-layout-column]");
  if (column === null) return { expanded: "no column", states: "no column", layers: -1 };
  const appOwn = (node) =>
    node.closest("[data-sample-sidebar-body], [data-testid='sample-model-picker']") === null;
  return {
    expanded: [...column.querySelectorAll("[aria-expanded]")]
      .filter(appOwn)
      .map((node) => node.getAttribute("aria-expanded"))
      .join(","),
    states: [...column.querySelectorAll("[data-state]")]
      .filter(appOwn)
      .map((node) => node.getAttribute("data-state"))
      .join(","),
    layers: [
      ...document.querySelectorAll(
        '[role="menu"],[role="dialog"],[role="listbox"],[data-radix-popper-content-wrapper]',
      ),
    ].filter(appOwn).length,
  };
})()`;

/**
 * `railTerminals` ended up above the divider, however the gesture got it there.
 *
 * The shipped rail carries no dividers (L-155), so both rail plans put one in
 * first through the product's own add-divider action - between Artifacts and
 * Terminals, which is where `divider:1` sat in the rail this wave replaced, so
 * the measured geometry the overshoot is tuned on is unchanged.
 *
 * `stack:railAgents+railArtifacts` is the shipped rail's one stack LINK
 * (L-166), named after the PAIR it joins. It is a member of the order like any
 * other entry, so it is named here; the rail draws the pair as one icon (G3).
 */
const TERMINALS_ABOVE_THE_DIVIDER = [
  "railAgents",
  "stack:railAgents+railArtifacts",
  "railArtifacts",
  "railTerminals",
  "divider:1",
  "railBrowsers",
  "railGitDiff",
  "railPullRequests",
  "railFileTree",
  "railSharing",
  "railComments",
];

// --- phase 2b: the side placements (A9 generalised, A11, A12, A13) ----------

/** The strip's own numbers (side-strip-tokens.ts, D4, S-20), restated so a drift is a failure. */
const SIDE_STRIP_RAIL_WIDTH = 60;
/**
 * The collapsed panel's rail: the vertical `EpicLeftPanelRail`'s `w-12`
 * (48px, not the strip's 60px rail). Flush surface: the collapsed rail
 * draws no border of its own any more, so this is the bare width.
 */
const PANEL_RAIL_SHEET_WIDTH = 48;
/** `env(titlebar-area-x, 82px)`: the fallback the fixture's `.wco` stands on (6.4). */
const WCO_LEADING_INSET_FALLBACK = 82;
/** `min(env(titlebar-area-x, 82px), 0.75rem)` while the inspector docks left (S-33). */
const LEFT_DOCK_COLUMN_GUTTER = 12;
/** The band floor: `max(env(titlebar-area-height, 0px), 40px)` (6.3). */
const TITLE_BAND_HEIGHT = 40;
/** S-35: the expanded row's leading tile and the status badge on it. */
const SIDE_TAB_LEADING_TILE = { width: 20, height: 16 };
const SIDE_TAB_BADGE = 10;
/** D4 and D5: the rail tile, its monogram chip, and the badge disc on the tile. */
const SIDE_TAB_TILE_WIDTH = 40;
const SIDE_TAB_TILE_HEIGHT = 44;
const SIDE_TAB_MONOGRAM_CHIP = { width: 26, height: 22 };
const SIDE_TAB_RAIL_BADGE = 14;
/**
 * How far apart two fills have to be, as a WCAG contrast ratio, to count as
 * two fills at all: the same fill sampled twice reads 1.00.
 */
const FILL_DIFFERS_FLOOR = 1.05;
/** A pixel is the session fill when every channel is this close to the painted token. */
const SOLID_FILL_TOLERANCE = 12;

/**
 * The windows under test, each a fresh navigation of the canvas fixture.
 *
 * `session` opens a layout session, because the right-docked inspector, the
 * editing frame and the session row exist only inside one; the rail cases run
 * at rest so a real click can make a TINTED tile the active one.
 */
const SIDE_VARIANTS = [
  {
    label: "left",
    query: { tabs: "left", collapsed: 0, wco: "none", dock: "right" },
    session: true,
    checks: ["frame", "sessionRow", "hits", "band", "rowKit"],
  },
  {
    label: "right",
    query: { tabs: "right", collapsed: 0, wco: "none", dock: "right" },
    session: true,
    checks: ["frame", "sessionRow", "hits", "band", "besideInspector"],
  },
  {
    label: "left, macOS",
    query: { tabs: "left", collapsed: 0, wco: "mac", dock: "right" },
    session: true,
    checks: ["hits", "band"],
  },
  {
    label: "right, macOS",
    query: { tabs: "right", collapsed: 0, wco: "mac", dock: "right" },
    session: true,
    checks: ["hits", "band", "besideInspector"],
  },
  {
    label: "left, Windows",
    query: { tabs: "left", collapsed: 0, wco: "win", dock: "right" },
    session: true,
    checks: ["hits", "band"],
  },
  {
    label: "right, macOS fullscreen",
    query: {
      tabs: "right",
      collapsed: 0,
      wco: "mac-fullscreen",
      dock: "right",
    },
    session: true,
    checks: ["band"],
  },
  {
    label: "left, macOS, inspector docked left",
    query: { tabs: "left", collapsed: 0, wco: "mac", dock: "left" },
    session: true,
    checks: ["hits", "dockLeftInset"],
  },
  {
    label: "rail left",
    query: { tabs: "left", collapsed: 1, wco: "none", dock: "right" },
    session: false,
    checks: ["rail", "tileFill"],
  },
  {
    label: "rail left, macOS",
    query: { tabs: "left", collapsed: 1, wco: "mac", dock: "right" },
    session: false,
    checks: ["rail"],
  },
  {
    label: "rail right",
    query: { tabs: "right", collapsed: 1, wco: "none", dock: "right" },
    session: false,
    checks: ["rail"],
  },
];

/**
 * What the band does in a window, from the chrome it simulates (S-04, 6.2):
 * a macOS left strip owns the title bar and draws no band, a frameless window
 * otherwise draws one, and macOS fullscreen keeps it in the tree but hidden.
 */
function expectedBand(query) {
  if (query.wco === "none") return "absent";
  if (query.tabs === "left" && query.wco !== "win") return "absent";
  if (query.wco === "mac-fullscreen") return "hidden";
  return "shown";
}

async function runSidePlacementPhase(client, pageUrl, pageLoads) {
  const violations = [];
  const notes = [];
  for (const variant of SIDE_VARIANTS) {
    const label = `side ${variant.label}`;
    const step = { name: "open" };
    try {
      await runSideVariant(
        client,
        pageUrl,
        pageLoads,
        variant,
        label,
        step,
        violations,
        notes,
      );
    } catch (error) {
      violations.push(
        `${label}: stopped at "${step.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\n--- side placements ---`);
  for (const note of notes) console.log(`  ${note}`);
  assert.deepEqual(
    violations,
    [],
    `The side placements failed (${String(violations.length)}):\n${violations.map((line) => `  - ${line}`).join("\n")}`,
  );
  console.log(
    `side placements passed: ${String(SIDE_VARIANTS.length)} windows - the frame on four edges with no header, the session row's solid fill, every strip part hit at its centre, the band per platform, the rail, the row kit`,
  );
}

/** One window of the side phase; `step` names where it is, for a stall. */
async function runSideVariant(
  client,
  pageUrl,
  pageLoads,
  variant,
  label,
  step,
  violations,
  notes,
) {
  const loadsAtStart = await openVariant(
    client,
    variantUrl(pageUrl, variant.query),
    label,
    "window.__layoutCanvasProbe?.ready === true && document.querySelector('[data-testid=\"side-tab-strip\"]') !== null",
    pageLoads,
  );
  await evaluate(client, INSTALL_PIXEL_TOOLS);
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  if (variant.session) {
    await evaluate(client, "window.__layoutCanvasProbe.beginSession()");
  }
  await moveTo(client, 1, 1);
  await flush(client);
  await delay(450);
  await flush(client);

  step.name = "base probe";
  const base = await evaluate(client, SIDE_VARIANT_PROBE);
  if (base.error !== null) {
    violations.push(`${label}: ${base.error}`);
    return;
  }
  notes.push(
    `${label}: column ${boxText(base.column)}, strip ${boxText(base.strip)} (data-edge=${String(base.edge)}), placement stamp ${String(base.placementStamp)}, band kind ${String(base.bandKind)}`,
  );
  // The strip is the stored edge's, flush with the column's edge, and the
  // specimen header is never used beside it.
  if (base.edge !== variant.query.tabs) {
    violations.push(
      `${label}: the strip carries data-edge=${String(base.edge)}, stored ${variant.query.tabs}`,
    );
  }
  const offEdge =
    variant.query.tabs === "left"
      ? Math.abs(base.strip.x - base.column.x)
      : Math.abs(
          base.strip.x + base.strip.width - (base.column.x + base.column.width),
        );
  if (offEdge > 0.5) {
    violations.push(
      `${label}: the strip at ${boxText(base.strip)} is not on the column's ${variant.query.tabs} edge ${boxText(base.column)}`,
    );
  }
  if (base.fixtureHeader) {
    violations.push(
      `${label}: the fixture's header specimen is mounted beside a side strip`,
    );
  }

  for (const check of variant.checks) {
    step.name = check;
    const result = await SIDE_CHECKS[check](client, variant, base);
    for (const line of result.violations)
      violations.push(`${label} ${check}: ${line}`);
    for (const line of result.notes) notes.push(`${label} ${check}: ${line}`);
  }
  if (variant.session) {
    await evaluate(client, "window.__layoutCanvasProbe.endSession()");
  }
  const errors = await evaluate(client, "window.__layoutCanvasErrors");
  if (errors.length > 0) {
    violations.push(
      `${label}: the fixture raised ${String(errors.length)} uncaught error(s):\n${errors.join("\n")}`,
    );
  }
  assertNoReloadSince(pageLoads, loadsAtStart, label, violations);
}

const SIDE_VARIANT_PROBE = `(() => {
  const column = document.querySelector("[data-layout-column]");
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  if (column === null || strip === null) return { error: "no app column or no side strip" };
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    error: null,
    column: rect(column),
    strip: rect(strip),
    edge: strip.getAttribute("data-edge"),
    placementStamp: column.getAttribute("data-tab-strip-placement"),
    bandKind: document.documentElement.getAttribute("data-app-title-band"),
    fixtureHeader: document.querySelector("[data-fixture-header]") !== null,
  };
})()`;

const SIDE_CHECKS = {
  frame: checkSideFrame,
  sessionRow: checkSessionRow,
  hits: checkStripHits,
  band: checkTitleBand,
  besideInspector: checkBesideInspector,
  dockLeftInset: checkDockLeftInset,
  rail: checkRail,
  tileFill: checkTileFill,
  rowKit: checkRowKit,
};

/**
 * A9 with the header absent: the editing frame is counted on all four edges of
 * the column, including the edge the strip now takes and the top edge that the
 * strip and the surface meet the window at.
 */
async function checkSideFrame(client, _variant, base) {
  const violations = [];
  const notes = [];
  const target = await sampleAmber(client);
  if (target === null) {
    return { violations: ["could not sample --warning-foreground"], notes };
  }
  const frame = await readFrameGeometry(client);
  if (
    frame.inset !== DESIGNED_FRAME_INSET ||
    frame.radius !== DESIGNED_FRAME_RADIUS
  ) {
    violations.push(
      `the frame is inset ${String(frame.inset)}px with a ${String(frame.radius)}px radius, expected ${String(DESIGNED_FRAME_INSET)}px and ${String(DESIGNED_FRAME_RADIUS)}px (L-137)`,
    );
  }
  const geometry = {
    inset: frame.inset ?? DESIGNED_FRAME_INSET,
    radius: frame.radius ?? DESIGNED_FRAME_RADIUS,
  };
  for (const edge of ["top", "bottom", "left", "right"]) {
    const count = await countEdge(client, base.column, edge, target, geometry);
    const ratio = count.along === 0 ? 0 : count.lit / count.along;
    const quarters = count.quarters.map((quarter) =>
      quarter.along === 0 ? 0 : quarter.lit / quarter.along,
    );
    notes.push(
      `${edge}: ${String(count.lit)}/${String(count.along)} lit (${(ratio * 100).toFixed(1)}%), quarters ${quarters.map((share) => `${(share * 100).toFixed(0)}%`).join(" ")}`,
    );
    if (ratio < FRAME_LIT_FLOOR || ratio > FRAME_LIT_CEILING) {
      violations.push(
        `${edge}: ${(ratio * 100).toFixed(1)}% of the straight run is amber, expected a dotted ${String(FRAME_LIT_FLOOR * 100)}-${String(FRAME_LIT_CEILING * 100)}%; column ${boxText(base.column)}`,
      );
    }
    for (const [index, share] of quarters.entries()) {
      if (share >= FRAME_QUARTER_LIT_FLOOR) continue;
      violations.push(
        `${edge}: quarter ${String(index + 1)} is ${(share * 100).toFixed(1)}% amber, so part of the edge is covered or missing; column ${boxText(base.column)}`,
      );
    }
  }
  return { violations, notes };
}

/**
 * The session row (L-163): the Customizing tab, active, is a SOLID
 * `--warning-foreground` object with `--background` text. Sampled in pixels
 * at three points of its fill clear of the label and the close button, so a
 * dim, a wash or a translucent fill all read as the defect they are.
 */
async function checkSessionRow(client) {
  const violations = [];
  const notes = [];
  const target = await sampleAmber(client);
  const row = await evaluate(
    client,
    `(() => {
      const marker = document.querySelector('[data-testid="side-tab-strip"] [data-layout-session-tab]');
      if (marker === null) return { error: "no session row in the strip" };
      const row = marker.closest("[data-side-tab]");
      if (row === null) return { error: "the session marker is outside a row" };
      const title = row.querySelector('[data-testid="side-tab-title"]');
      const probe = document.createElement("span");
      probe.style.display = "none";
      row.append(probe);
      const resolve = (value) => {
        probe.style.color = "";
        probe.style.color = value;
        return getComputedStyle(probe).color;
      };
      const background = resolve("var(--background)");
      probe.remove();
      const r = row.getBoundingClientRect();
      return {
        error: null,
        marker: marker.getAttribute("data-layout-session-tab"),
        active: row.getAttribute("data-active"),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        titleColor: title === null ? null : getComputedStyle(title).color,
        background,
      };
    })()`,
  );
  if (row.error !== null) return { violations: [row.error], notes };
  if (row.marker !== "filled" || row.active !== "true") {
    violations.push(
      `the session row is ${String(row.marker)} / active=${String(row.active)}, expected the filled, active Customizing tab`,
    );
  }
  if (row.titleColor !== row.background) {
    violations.push(
      `the session row's label is ${String(row.titleColor)}, expected the --background colour ${String(row.background)}`,
    );
  }
  const points = [
    {
      name: "leading padding",
      x: row.rect.x + 3,
      y: row.rect.y + row.rect.height / 2,
    },
    {
      name: "top margin",
      x: row.rect.x + row.rect.width * 0.55,
      y: row.rect.y + 3,
    },
    {
      name: "bottom margin",
      x: row.rect.x + row.rect.width * 0.35,
      y: row.rect.y + row.rect.height - 4,
    },
  ];
  for (const point of points) {
    const pixel = await samplePixelAt(client, point.x, point.y);
    const off =
      target === null || pixel === null
        ? Number.POSITIVE_INFINITY
        : Math.max(
            ...pixel.map((channel, index) => Math.abs(channel - target[index])),
          );
    notes.push(
      `session row ${point.name} paints rgb(${String(pixel)}) against the token rgb(${String(target)})`,
    );
    if (off > SOLID_FILL_TOLERANCE) {
      violations.push(
        `the session row's ${point.name} at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) paints rgb(${String(pixel)}), not the solid --warning-foreground rgb(${String(target)}) (L-163)`,
      );
    }
  }
  return { violations, notes };
}

/**
 * A11: every strip part is the hit target at its own centre - the top block's
 * buttons, Home, a row, the active row's close, every foot control and the
 * resize handle - so nothing (a band, the inspector, the surface's corner, an
 * overlay) sits over the strip where it takes input. A natively disabled
 * button takes no pointer events by design; its tooltip wrapper of the same
 * box is then the target, which is what the product built it for.
 */
async function checkStripHits(client, variant) {
  const violations = [];
  const notes = [];
  // The arrows self-gate on the desktop's persistent history: a browser shell
  // has its own back button, so there they must be absent, not merely skipped.
  const desktop = variant.query.wco !== "none";
  const parts = await evaluate(
    client,
    `(() => {
      const strip = document.querySelector('[data-testid="side-tab-strip"]');
      const q = (selector) => strip.querySelector(selector);
      const arrows = ${String(desktop)}
        ? [
            ["back", q('[data-testid="history-nav-back"]')],
            ["forward", q('[data-testid="history-nav-forward"]')],
          ]
        : [];
      const strayArrows = ${String(desktop)} ? 0 : strip.querySelectorAll('[data-testid^="history-nav-"]').length;
      const named = [
        ...arrows,
        ["new task", q('[data-testid="side-strip-new-task"]')],
        ["collapse", q('[data-testid="side-tab-strip-collapse"]')],
        ["home", q('[data-testid="tab-home"]')],
        ["row", [...strip.querySelectorAll('[data-testid="header-tab-strip-scroll"] [data-side-tab]')].find((row) => row.getAttribute("data-active") !== "true") ?? null],
        ["close", q('[data-revealed="always"] [data-testid^="tab-close-"]')],
        ["handle", q('[data-testid="side-tab-strip-resize-handle"]')],
      ];
      const foot = q('[data-testid="side-strip-foot"]');
      const footControls = foot === null ? [] : [...foot.querySelectorAll("button, a[href], [role='button']")];
      footControls.forEach((node, index) => named.push(["foot " + (node.getAttribute("aria-label") ?? node.getAttribute("data-testid") ?? String(index)), node]));
      if (foot !== null && footControls.length === 0) named.push(["foot (no control)", null]);
      if (strayArrows > 0) named.push(["history arrows in a browser shell", strip.querySelector('[data-testid^="history-nav-"]'), "stray"]);
      return named.map(([name, node, stray]) => {
        if (stray === "stray") return { name, error: "drawn although the shell has no persistent history" };
        if (node === null) return { name, error: "not in the strip" };
        const r = node.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        const own = hit !== null && (hit === node || node.contains(hit));
        const wrapper = node.parentElement;
        const w = wrapper === null ? null : wrapper.getBoundingClientRect();
        const disabledWrapper =
          node.disabled === true &&
          hit === wrapper &&
          w !== null &&
          Math.abs(w.width - r.width) < 1 &&
          Math.abs(w.height - r.height) < 1;
        return {
          name,
          error: null,
          width: r.width,
          height: r.height,
          x,
          y,
          ok: own || disabledWrapper,
          disabled: node.disabled === true,
          inStrip: hit !== null && strip.contains(hit),
          hit: hit === null ? null : hit.tagName + "." + String(hit.getAttribute("class") ?? "").slice(0, 70) + (hit.getAttribute("data-testid") ? "#" + hit.getAttribute("data-testid") : ""),
        };
      });
    })()`,
  );
  for (const part of parts) {
    if (part.error !== null) {
      violations.push(`${part.name}: ${part.error}`);
      continue;
    }
    if (part.width === 0 || part.height === 0) {
      violations.push(
        `${part.name}: its box is ${String(part.width)}x${String(part.height)}`,
      );
      continue;
    }
    if (!part.ok) {
      violations.push(
        `${part.name}: elementFromPoint(${part.x.toFixed(0)}, ${part.y.toFixed(0)}) is ${String(part.hit)} (inside the strip: ${String(part.inStrip)})`,
      );
    }
  }
  notes.push(
    `${String(parts.length)} parts hit-tested: ${parts.map((part) => part.name + (part.disabled ? " (disabled)" : "")).join(", ")}`,
  );
  return { violations, notes };
}

/**
 * A13 and the surface frame's inset (S-04, 6.2, 6.3, D1): the band's
 * presence and height, the strip's top against the band's bottom, the 40px
 * title row where the strip owns the title bar, the frame one shell gap in
 * from the band or the window top in every case (the sheets replaced the -1px
 * tuck of review-09 M1), and where a dialog overlay starts under `.wco`.
 */
async function checkTitleBand(client, variant, base) {
  const violations = [];
  const notes = [];
  const expected = expectedBand(variant.query);
  const band = await evaluate(
    client,
    `(() => {
      const band = document.querySelector('[data-testid="app-title-band"]');
      const strip = document.querySelector('[data-testid="side-tab-strip"]');
      const titleRow = document.querySelector('[data-testid="side-strip-title-row"]');
      const surface = document.querySelector('[data-layout-column] main > div');
      const overlay = document.createElement("div");
      overlay.setAttribute("data-slot", "dialog-overlay");
      overlay.style.position = "fixed";
      overlay.style.pointerEvents = "none";
      document.body.append(overlay);
      const overlayTop = getComputedStyle(overlay).top;
      overlay.remove();
      const rect = (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return {
        band: band === null ? null : { rect: rect(band), display: getComputedStyle(band).display },
        stripTop: strip.getBoundingClientRect().top,
        titleRow: titleRow === null ? null : { rect: rect(titleRow), paddingLeft: getComputedStyle(titleRow).paddingLeft },
        surfaceMarginTop: surface === null ? null : getComputedStyle(surface).marginTop,
        surfaceClass: surface === null ? null : surface.getAttribute("class"),
        overlayTop,
        wco: document.documentElement.classList.contains("wco"),
        bandVariable: getComputedStyle(document.documentElement).getPropertyValue("--app-title-band-height").trim(),
      };
    })()`,
  );
  const shown = band.band !== null && band.band.display !== "none";
  notes.push(
    `expected band ${expected}; band ${band.band === null ? "absent" : `${band.band.display} ${boxText(band.band.rect)}`}, strip top ${band.stripTop.toFixed(1)}, title row ${band.titleRow === null ? "none" : `${boxText(band.titleRow.rect)} pl=${band.titleRow.paddingLeft}`}, surface margin-top ${String(band.surfaceMarginTop)}, dialog overlay top ${band.overlayTop}, .wco=${String(band.wco)}`,
  );
  if (expected === "absent" && band.band !== null) {
    violations.push(
      `a title band is mounted (${band.band.display}) where the chrome draws none`,
    );
  }
  if (expected === "hidden") {
    if (band.band === null)
      violations.push("no title band in the tree for a frameless right strip");
    else if (shown)
      violations.push(
        `the band is displayed (${band.band.display}) with no window-controls overlay`,
      );
  }
  if (expected === "shown") {
    if (!shown) {
      violations.push(
        `the band is ${band.band === null ? "absent" : "hidden"} where the native controls need it`,
      );
    } else {
      if (Math.abs(band.band.rect.height - TITLE_BAND_HEIGHT) > 0.5) {
        violations.push(
          `the band is ${band.band.rect.height.toFixed(1)}px tall, expected the ${String(TITLE_BAND_HEIGHT)}px floor of --app-title-band-height`,
        );
      }
      const bandBottom = band.band.rect.y + band.band.rect.height;
      if (Math.abs(bandBottom - band.stripTop) > 0.5) {
        violations.push(
          `the band ends at y=${bandBottom.toFixed(1)} and the strip starts at y=${band.stripTop.toFixed(1)}; the strip must start where the band ends`,
        );
      }
    }
  }
  // Flush surface (5c7ba8ea): the frame meets the band, or the window top,
  // with no shell gap of its own.
  if (band.surfaceMarginTop !== "0px") {
    violations.push(
      `the surface frame's margin-top is ${String(band.surfaceMarginTop)}, expected 0px: the task surface is flush under the band or the window top (class "${String(band.surfaceClass)}")`,
    );
  }
  if (variant.query.wco === "mac" && variant.query.tabs === "left") {
    if (band.titleRow === null) {
      violations.push(
        "the strip draws no title row where it owns the title bar",
      );
    } else {
      if (Math.abs(band.titleRow.rect.height - TITLE_BAND_HEIGHT) > 0.5) {
        violations.push(
          `the strip's title row is ${band.titleRow.rect.height.toFixed(1)}px tall, expected ${String(TITLE_BAND_HEIGHT)}px`,
        );
      }
      if (Math.abs(band.titleRow.rect.y - base.column.y) > 0.5) {
        violations.push(
          `the strip's title row starts at y=${band.titleRow.rect.y.toFixed(1)}, not at the window top`,
        );
      }
      if (
        band.titleRow.paddingLeft !== `${String(WCO_LEADING_INSET_FALLBACK)}px`
      ) {
        violations.push(
          `the title row pads ${band.titleRow.paddingLeft} at the leading edge, expected the ${String(WCO_LEADING_INSET_FALLBACK)}px traffic-light inset`,
        );
      }
    }
  } else if (band.titleRow !== null) {
    violations.push(
      "the strip draws a title row although it does not own the title bar",
    );
  }
  if (band.wco) {
    const overlayTop = shown ? `${String(TITLE_BAND_HEIGHT)}px` : "0px";
    if (band.overlayTop !== overlayTop) {
      violations.push(
        `a dialog overlay starts at top ${band.overlayTop}, expected ${overlayTop} (--app-title-band-height is "${band.bandVariable}")`,
      );
    }
  }
  return { violations, notes };
}

/** A right strip sits left of a right-docked inspector, never under it (6.1). */
async function checkBesideInspector(client, _variant, base) {
  const violations = [];
  const notes = [];
  const inspector = await rectOf(client, "[data-layout-inspector]");
  if (inspector === null)
    return { violations: ["no inspector in the session"], notes };
  notes.push(`inspector ${boxText(inspector)}, strip ${boxText(base.strip)}`);
  if (base.strip.x + base.strip.width > inspector.x + 0.5) {
    violations.push(
      `the strip ends at x=${(base.strip.x + base.strip.width).toFixed(1)}, past the inspector's left edge at x=${inspector.x.toFixed(1)}`,
    );
  }
  return { violations, notes };
}

/**
 * The traffic-light reserve belongs to whatever sits at the window's top-left
 * corner (S-28, S-33): with the inspector docked left its header keeps at
 * least the 82px inset, and the strip's title row beside it drops to 12px.
 */
async function checkDockLeftInset(client) {
  const violations = [];
  const notes = [];
  const read = await evaluate(
    client,
    `(() => {
      const header = document.querySelector("[data-layout-inspector-header]");
      const titleRow = document.querySelector('[data-testid="side-strip-title-row"]');
      const inspector = document.querySelector("[data-layout-inspector]");
      const column = document.querySelector("[data-layout-column]");
      return {
        headerPadding: header === null ? null : Number.parseFloat(getComputedStyle(header).paddingLeft),
        titleRowPadding: titleRow === null ? null : Number.parseFloat(getComputedStyle(titleRow).paddingLeft),
        inspectorLeft: inspector === null ? null : inspector.getBoundingClientRect().left,
        columnLeft: column === null ? null : column.getBoundingClientRect().left,
      };
    })()`,
  );
  notes.push(
    `inspector header pads ${String(read.headerPadding)}px, title row pads ${String(read.titleRowPadding)}px; inspector left ${String(read.inspectorLeft)}, column left ${String(read.columnLeft)}`,
  );
  if (
    read.inspectorLeft === null ||
    read.columnLeft === null ||
    read.inspectorLeft > read.columnLeft
  ) {
    violations.push(
      "the inspector is not docked at the window's left, so the reserve is untested",
    );
  }
  if (
    read.headerPadding === null ||
    read.headerPadding < WCO_LEADING_INSET_FALLBACK
  ) {
    violations.push(
      `the left-docked inspector's header pads ${String(read.headerPadding)}px, under the ${String(WCO_LEADING_INSET_FALLBACK)}px traffic-light inset`,
    );
  }
  if (read.titleRowPadding !== LEFT_DOCK_COLUMN_GUTTER) {
    violations.push(
      `the strip's title row pads ${String(read.titleRowPadding)}px beside a left-docked inspector, expected the ${String(LEFT_DOCK_COLUMN_GUTTER)}px gutter`,
    );
  }
  return { violations, notes };
}

/**
 * A12 and D4: the collapsed rail is 60px (never under the 82px inset on macOS
 * with the strip at the left, D15), and each monogram tile is a centred 40x44
 * tile holding a 26x22 chip with its letters actually drawn (ink inside the
 * chip that is not the chip's fill) over the meter's row, which every tile
 * mounts so the monogram never moves.
 */
async function checkRail(client, variant, base) {
  const violations = [];
  const notes = [];
  const floor =
    variant.query.wco === "mac" && variant.query.tabs === "left"
      ? Math.max(SIDE_STRIP_RAIL_WIDTH, WCO_LEADING_INSET_FALLBACK)
      : SIDE_STRIP_RAIL_WIDTH;
  const exact = floor === SIDE_STRIP_RAIL_WIDTH;
  notes.push(
    `rail ${base.strip.width.toFixed(1)}px wide (expected ${exact ? "" : "at least "}${String(floor)}px)`,
  );
  if (
    exact
      ? Math.abs(base.strip.width - floor) > 0.5
      : base.strip.width < floor - 0.5
  ) {
    violations.push(
      `the rail is ${base.strip.width.toFixed(1)}px wide, expected ${exact ? "" : "at least "}${String(floor)}px (D4, D15)`,
    );
  }
  const tiles = await evaluate(
    client,
    `(() => [...document.querySelectorAll('[data-testid="side-tab-strip"] [data-side-tab="collapsed"][data-tile-kind="monogram"]')].map((tile) => {
      const box = (node) => {
        if (node === null) return null;
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const chip = tile.querySelector('[data-testid="side-tab-monogram-chip"]');
      const meter = tile.querySelector('[data-testid="side-tab-meter"]');
      return {
        text: (chip?.textContent ?? "").trim(),
        rect: box(tile),
        chip: box(chip),
        meter: box(meter),
      };
    }))()`,
  );
  if (tiles.length === 0) violations.push("no monogram tile in the rail");
  const stripCentre = base.strip.x + base.strip.width / 2;
  for (const tile of tiles) {
    if (
      Math.abs(tile.rect.width - SIDE_TAB_TILE_WIDTH) > 0.5 ||
      Math.abs(tile.rect.height - SIDE_TAB_TILE_HEIGHT) > 0.5
    ) {
      violations.push(
        `the "${tile.text}" tile is ${tile.rect.width.toFixed(1)}x${tile.rect.height.toFixed(1)}, expected ${String(SIDE_TAB_TILE_WIDTH)}x${String(SIDE_TAB_TILE_HEIGHT)} (D4)`,
      );
    }
    const tileCentre = tile.rect.x + tile.rect.width / 2;
    if (Math.abs(tileCentre - stripCentre) > 1) {
      violations.push(
        `the "${tile.text}" tile is centred at x=${tileCentre.toFixed(1)}, the rail at x=${stripCentre.toFixed(1)}`,
      );
    }
    if (tile.chip === null) {
      violations.push(`the "${tile.text}" tile draws no monogram chip`);
      continue;
    }
    if (
      Math.abs(tile.chip.width - SIDE_TAB_MONOGRAM_CHIP.width) > 0.5 ||
      Math.abs(tile.chip.height - SIDE_TAB_MONOGRAM_CHIP.height) > 0.5
    ) {
      violations.push(
        `the "${tile.text}" chip is ${tile.chip.width.toFixed(1)}x${tile.chip.height.toFixed(1)}, expected ${String(SIDE_TAB_MONOGRAM_CHIP.width)}x${String(SIDE_TAB_MONOGRAM_CHIP.height)}`,
      );
    }
    if (tile.meter === null) {
      violations.push(
        `the "${tile.text}" tile mounts no meter, so its monogram moves when one arrives`,
      );
    } else if (tile.meter.y < tile.chip.y + tile.chip.height - 0.5) {
      violations.push(
        `the "${tile.text}" meter starts at y=${tile.meter.y.toFixed(1)}, inside the chip ending at y=${(tile.chip.y + tile.chip.height).toFixed(1)}`,
      );
    }
    if (tile.text.length === 0) {
      violations.push(
        `a monogram tile at ${boxText(tile.rect)} has no letters`,
      );
      continue;
    }
    // Ink: pixels in the chip's middle that differ from the fill beside them.
    const ink = await inkInside(client, tile.chip, null);
    if (ink < 4) {
      violations.push(
        `the "${tile.text}" monogram paints ${String(ink)} ink pixels, so its letters are not drawn`,
      );
    }
  }
  notes.push(
    `${String(tiles.length)} monogram tiles: ${tiles.map((tile) => tile.text).join(" ")}`,
  );
  return { violations, notes };
}

/**
 * The rail tile's two fills in both themes (D4, D11), replacing the tinted
 * tile's active ring, which the tile no longer draws: the tint lives on the
 * chip (`data-tint` is `tab` for a coloured tab, `auto` for a task without
 * one), and the ACTIVE tile paints its own fill around the chip. Delta (a tab
 * colour) and Epsilon (none, so its own hue) are read inactive and then active,
 * at the tile's rim, beside the chip.
 */
async function checkTileFill(client) {
  const violations = [];
  const notes = [];
  try {
    for (const theme of ["light", "dark"]) {
      await measureTileFill(client, theme, violations, notes);
    }
  } finally {
    // The theme is persisted, so the next variant's document would boot in
    // the last one set here; every variant starts from the shipped "system".
    await evaluate(client, 'window.__layoutCanvasProbe.setTheme("system")');
  }
  return { violations, notes };
}

const TILES_BY_MONOGRAM_PROBE = `(() => {
  const tiles = [...document.querySelectorAll('[data-testid="side-tab-strip"] [data-side-tab="collapsed"][data-tile-kind="monogram"]')];
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return Object.fromEntries(tiles.map((tile) => {
    const chip = tile.querySelector('[data-testid="side-tab-monogram-chip"]');
    return [(chip?.textContent ?? "").trim(), {
      rect: box(tile),
      chip: chip === null ? null : box(chip),
      tint: tile.getAttribute("data-tint"),
      active: tile.getAttribute("data-active"),
    }];
  }));
})()`;

async function measureTileFill(client, theme, violations, notes) {
  await evaluate(
    client,
    `window.__layoutCanvasProbe.setTheme(${JSON.stringify(theme)})`,
  );
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await evaluate(
    client,
    'window.__layoutCanvasProbe.activateEpicTab("fixture-zeta")',
  );
  await moveTo(client, 1, 1);
  await flush(client);
  await delay(200);
  const cases = [
    { monogram: "DM", epicId: "fixture-delta", tint: "tab" },
    { monogram: "EC", epicId: "fixture-epsilon", tint: "auto" },
  ];
  const rimOf = (tile) => ({ x: tile.rect.x + 3, y: tile.rect.y + 3 });
  const resting = await evaluate(client, TILES_BY_MONOGRAM_PROBE);
  for (const entry of cases) {
    const tile = resting[entry.monogram];
    if (tile === undefined || tile.chip === null) {
      violations.push(`${theme}: no "${entry.monogram}" tile with a chip`);
      continue;
    }
    if (tile.tint !== entry.tint) {
      violations.push(
        `${theme}: the "${entry.monogram}" tile is data-tint=${String(tile.tint)}, expected ${entry.tint} (D11)`,
      );
    }
    const rim = rimOf(tile);
    const inactiveRim = await samplePixelAt(client, rim.x, rim.y);
    const chipPixel = await samplePixelAt(
      client,
      tile.chip.x + 2,
      tile.chip.y + tile.chip.height / 2,
    );
    await evaluate(
      client,
      `window.__layoutCanvasProbe.activateEpicTab(${JSON.stringify(entry.epicId)})`,
    );
    await flush(client);
    await delay(200);
    const active = (await evaluate(client, TILES_BY_MONOGRAM_PROBE))[
      entry.monogram
    ];
    const activeRim = await samplePixelAt(client, rim.x, rim.y);
    const fillRatio = contrastRatio(inactiveRim, activeRim);
    const chipRatio = contrastRatio(chipPixel, inactiveRim);
    notes.push(
      `${theme}: "${entry.monogram}" (${String(tile.tint)}) rim rgb(${String(inactiveRim)}) -> active rgb(${String(activeRim)}) = ${fillRatio.toFixed(2)}:1; chip rgb(${String(chipPixel)}) against the rim ${chipRatio.toFixed(2)}:1`,
    );
    if (active?.active !== "true") {
      violations.push(
        `${theme}: "${entry.monogram}" is data-active=${String(active?.active)} after activating it`,
      );
    }
    if (fillRatio < FILL_DIFFERS_FLOOR) {
      violations.push(
        `${theme}: the active "${entry.monogram}" tile paints the same rim as at rest (${fillRatio.toFixed(2)}:1), so nothing marks it active`,
      );
    }
    if (chipRatio < FILL_DIFFERS_FLOOR) {
      violations.push(
        `${theme}: the "${entry.monogram}" chip paints its tile's own fill (${chipRatio.toFixed(2)}:1), so its tint is not drawn`,
      );
    }
    await evaluate(
      client,
      'window.__layoutCanvasProbe.activateEpicTab("fixture-zeta")',
    );
    await flush(client);
    await delay(150);
  }
}

/**
 * The row kit in the expanded strip, at rest (review-10): the 10px badge on a
 * 16px leading tile, drawn and not clipped; and the group line down the
 * group's inline-start edge as ONE continuous line across its members,
 * including the split pair's rows inside the pair's padding.
 */
async function checkRowKit(client) {
  const violations = [];
  const notes = [];
  await evaluate(client, "window.__layoutCanvasProbe.endSession()");
  await moveTo(client, 1, 1);
  await flush(client);
  await delay(300);
  const kit = await evaluate(
    client,
    `(() => {
      const strip = document.querySelector('[data-testid="side-tab-strip"]');
      const scroller = strip.querySelector('[data-testid="header-tab-strip-scroll"]');
      const rect = (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const badge = strip.querySelector('[data-side-tab="expanded"] [data-testid="side-tab-leading"] [data-testid="side-tab-rail-badge"]');
      const tile = badge === null ? null : badge.closest('[data-testid="side-tab-leading"]').querySelector('[data-testid="side-tab-leading-tile"]');
      const title = badge === null ? null : badge.closest('[data-side-tab]').querySelector('[data-testid="side-tab-title"]');
      const lines = [...strip.querySelectorAll('[data-testid="side-tab-group-line"]')].map((line) => ({
        rect: rect(line),
        color: getComputedStyle(line).backgroundColor,
        inPair: line.closest("[data-side-split-pair]") !== null,
      }));
      return {
        scroller: scroller === null ? null : rect(scroller),
        badge: badge === null ? null : { rect: rect(badge), kind: badge.getAttribute("data-kind"), color: getComputedStyle(badge).backgroundColor },
        tile: tile === null ? null : rect(tile),
        title: title === null ? null : rect(title),
        lines,
      };
    })()`,
  );
  if (kit.badge === null || kit.tile === null) {
    violations.push(
      "no status badge on an expanded row's leading tile (the seeded failure on Delta)",
    );
  } else {
    notes.push(
      `badge ${String(kit.badge.kind)} ${boxText(kit.badge.rect)} on tile ${boxText(kit.tile)}`,
    );
    if (
      Math.abs(kit.tile.width - SIDE_TAB_LEADING_TILE.width) > 0.5 ||
      Math.abs(kit.tile.height - SIDE_TAB_LEADING_TILE.height) > 0.5
    ) {
      violations.push(
        `the leading tile is ${kit.tile.width.toFixed(1)}x${kit.tile.height.toFixed(1)}, expected ${String(SIDE_TAB_LEADING_TILE.width)}x${String(SIDE_TAB_LEADING_TILE.height)} (S-35, R1)`,
      );
    }
    if (
      Math.abs(kit.badge.rect.width - SIDE_TAB_BADGE) > 0.5 ||
      Math.abs(kit.badge.rect.height - SIDE_TAB_BADGE) > 0.5
    ) {
      violations.push(
        `the badge is ${kit.badge.rect.width.toFixed(1)}x${kit.badge.rect.height.toFixed(1)}, expected ${String(SIDE_TAB_BADGE)}px (S-17)`,
      );
    }
    // A8: the badge sits in the space reserved beside the tile, level with its
    // top, so it never covers the monogram and its 2px ring never reaches the
    // title.
    const tileRight = kit.tile.x + kit.tile.width;
    if (kit.badge.rect.x < tileRight - 0.5) {
      violations.push(
        `the badge starts at x=${kit.badge.rect.x.toFixed(1)}, over the leading tile that ends at x=${tileRight.toFixed(1)}, so it covers the monogram`,
      );
    }
    if (Math.abs(kit.badge.rect.y - (kit.tile.y - 2)) > 0.5) {
      violations.push(
        `the badge's top is at y=${kit.badge.rect.y.toFixed(1)}, not 2px above the tile's top at y=${kit.tile.y.toFixed(1)}`,
      );
    }
    if (kit.title === null) {
      violations.push(
        "the badged row has no title to measure the badge against",
      );
    } else if (
      kit.badge.rect.x + kit.badge.rect.width + 2 >
      kit.title.x + 0.5
    ) {
      violations.push(
        `the badge's ring ends at x=${(kit.badge.rect.x + kit.badge.rect.width + 2).toFixed(1)}, past the title's start at x=${kit.title.x.toFixed(1)}`,
      );
    }
    if (kit.scroller !== null && kit.badge.rect.y - 2 < kit.scroller.y - 0.5) {
      violations.push(
        `the badge's ring reaches y=${(kit.badge.rect.y - 2).toFixed(1)}, above the scroller's top at y=${kit.scroller.y.toFixed(1)}, so it is clipped`,
      );
    }
    // MessageSquareX paints through the centre; count ink against the known
    // ground because the badge is too small for an empty padding sample.
    const expected = await resolveRgb(client, kit.badge.color);
    const ink =
      expected === null ? 0 : await inkInside(client, kit.badge.rect, expected);
    notes.push(
      `badge ink pixels: ${String(ink)} against its ground colour rgb(${String(expected)})`,
    );
    if (ink < 4) {
      violations.push(
        `the badge paints ${String(ink)} ink pixels inside its ${kit.badge.rect.width.toFixed(1)}x${kit.badge.rect.height.toFixed(1)} box, so its status glyph is not drawn`,
      );
    }
  }

  const lines = kit.lines;
  if (lines.length < 3) {
    violations.push(
      `${String(lines.length)} group line segments, expected one per member of the seeded group (Alpha and the Beta/Gamma pair)`,
    );
  } else {
    notes.push(
      `group line segments: ${lines.map((line) => `${boxText(line.rect)}${line.inPair ? " (in pair)" : ""}`).join(", ")}`,
    );
    const x0 = lines[0].rect.x;
    for (const line of lines) {
      if (Math.abs(line.rect.x - x0) > 0.5) {
        violations.push(
          `a group line segment${line.inPair ? " inside the split pair" : ""} sits at x=${line.rect.x.toFixed(1)}, the group's first at x=${x0.toFixed(1)}: the line steps sideways`,
        );
      }
    }
    for (let index = 1; index < lines.length; index += 1) {
      const above = lines[index - 1].rect;
      const below = lines[index].rect;
      const gap = below.y - (above.y + above.height);
      if (gap > 0.5) {
        violations.push(
          `the group line breaks for ${gap.toFixed(1)}px between y=${(above.y + above.height).toFixed(1)} and y=${below.y.toFixed(1)}`,
        );
      }
    }
    // The pixels, top to bottom down the first segment's centre column.
    const top = lines[0].rect.y;
    const bottom = lines.at(-1).rect.y + lines.at(-1).rect.height;
    const colour = await resolveRgb(client, lines[0].color);
    if (colour !== null) {
      await ensurePixelTools(client);
      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: x0 + lines[0].rect.width / 2 - 0.5,
          y: top,
          width: 1,
          height: Math.max(1, bottom - top),
          scale: 1,
        },
        captureBeyondViewport: false,
      });
      const count = await evaluate(
        client,
        `window.__countShot(${JSON.stringify(shot.data)}, false, ${JSON.stringify(colour)}, 60)`,
      );
      const share = count.along === 0 ? 0 : count.lit / count.along;
      notes.push(
        `group line pixels: ${String(count.lit)}/${String(count.along)} in the group colour rgb(${String(colour)}) from y=${top.toFixed(1)} to y=${bottom.toFixed(1)}`,
      );
      if (share < 0.97) {
        violations.push(
          `only ${(share * 100).toFixed(1)}% of the group line's run from y=${top.toFixed(1)} to y=${bottom.toFixed(1)} is painted in the group colour, so it is not one continuous line`,
        );
      }
    }
  }
  return { violations, notes };
}

// --- phase 2c: the live placement switch (A14) -----------------------------

async function runLiveSwitchPhase(client, pageUrl, pageLoads) {
  const violations = [];
  const notes = [];
  const label = "live switch";
  const loadsAtStart = await openVariant(
    client,
    variantUrl(pageUrl, {
      tabs: "top",
      collapsed: 0,
      wco: "none",
      dock: "right",
    }),
    label,
    "window.__layoutCanvasProbe?.ready === true",
    pageLoads,
  );
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await evaluate(client, "window.__layoutCanvasProbe.beginSession()");
  await moveTo(client, 1, 1);
  await flush(client);
  await delay(450);
  await flush(client);

  // The two-level form (T3/T4): a real click on the Task tabs row opens its
  // area before the Tab placement control exists in the document.
  const taskTabsArea = await rectOf(
    client,
    '[data-layout-inspector] [data-layout-area="topBar"]',
  );
  if (taskTabsArea !== null) {
    await moveTo(client, taskTabsArea.cx, taskTabsArea.cy);
    await pressAndRelease(client, taskTabsArea.cx, taskTabsArea.cy, "left");
    await flush(client);
  }

  const radio = await evaluate(
    client,
    `(() => {
      const group = document.querySelector('[data-layout-inspector] [role="radiogroup"][aria-label="Tab placement"]');
      if (group === null) return null;
      const left = [...group.querySelectorAll('[role="radio"]')].find((node) => (node.textContent ?? "").trim() === "Left") ?? null;
      if (left === null) return null;
      left.scrollIntoView({ block: "center" });
      return true;
    })()`,
  );
  if (taskTabsArea === null) {
    violations.push(
      "A14: the inspector's All settings list shows no Task tabs row",
    );
  } else if (radio === null) {
    violations.push(
      "A14: the Task tabs area shows no Tab placement radio labelled Left",
    );
  } else {
    await flush(client);
    const left = await rectOf(
      client,
      '[data-layout-inspector] [role="radiogroup"][aria-label="Tab placement"] [role="radio"]:nth-child(2)',
    );
    const depthBefore = await evaluate(
      client,
      "window.__layoutCanvasProbe.historyDepth()",
    );
    await moveTo(client, left.cx, left.cy);
    await pressAndRelease(client, left.cx, left.cy, "left");
    // ONE frame after the click, not a settle: the strip is where it will stay.
    const first = await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => resolve(${STRIP_PLACEMENT_PROBE})))`,
    );
    await delay(500);
    await flush(client);
    const settled = await evaluate(client, STRIP_PLACEMENT_PROBE);
    const depthAfter = await evaluate(
      client,
      "window.__layoutCanvasProbe.historyDepth()",
    );
    notes.push(
      `one frame after the click: ${JSON.stringify(first)}; settled: ${JSON.stringify(settled)}; history ${String(depthBefore)} -> ${String(depthAfter)}`,
    );
    if (first.placement !== "left" || first.strip === null) {
      violations.push(
        `A14: one frame after a real click on Left the column is ${String(first.placement)} with ${first.strip === null ? "no strip" : "a strip"}`,
      );
    } else {
      if (Math.abs(first.strip.x - first.column.x) > 0.5) {
        violations.push(
          `A14: the strip is at ${boxText(first.strip)}, not on the column's left edge ${boxText(first.column)}`,
        );
      }
      if (
        settled.strip === null ||
        !sameBoxWithin(first.strip, settled.strip, 0.5)
      ) {
        violations.push(
          `A14: the strip kept moving after the first frame (${boxText(first.strip)} -> ${settled.strip === null ? "gone" : boxText(settled.strip)}), so the switch is animated rather than one frame`,
        );
      }
      if (first.header)
        violations.push(
          "A14: the header is still mounted beside the left strip",
        );
    }
    if (depthAfter !== depthBefore + 1) {
      violations.push(
        `A14: the click cost ${String(depthAfter - depthBefore)} history steps, expected one`,
      );
    }

    // The selection ring rides the moved node (L-90): select a rail icon beside
    // the strip, undo the switch, and read the ring one frame later.
    const icon = await rectOf(client, regionSelector("railBrowsers"));
    await pressAndRelease(client, icon.cx, icon.cy, "left");
    await delay(500);
    await flush(client);
    const ringBefore = await evaluate(client, ringProbe("railBrowsers"));
    const undo = await rectOf(
      client,
      '[data-layout-inspector] button[aria-label="Undo"]',
    );
    if (ringBefore.error !== null || undo === null) {
      violations.push(
        `A14: ${ringBefore.error ?? "no Undo button in the inspector"}`,
      );
    } else {
      await moveTo(client, undo.cx, undo.cy);
      await pressAndRelease(client, undo.cx, undo.cy, "left");
      const afterUndo = await evaluate(
        client,
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ placement: ${STRIP_PLACEMENT_PROBE}, ring: ${ringProbe("railBrowsers")} }))))`,
      );
      const depthUndone = await evaluate(
        client,
        "window.__layoutCanvasProbe.historyDepth()",
      );
      notes.push(
        `after one undo: ${JSON.stringify(afterUndo.placement)}; ring ${afterUndo.ring.error ?? `${boxText(afterUndo.ring.ring)} on ${boxText(afterUndo.ring.region)}`} (was on ${boxText(ringBefore.region)}); history ${String(depthUndone)}`,
      );
      if (
        afterUndo.placement.placement !== "top" ||
        afterUndo.placement.strip !== null ||
        !afterUndo.placement.header
      ) {
        violations.push(
          `A14: one undo left the column at ${String(afterUndo.placement.placement)} (strip ${afterUndo.placement.strip === null ? "gone" : "still mounted"}, header ${String(afterUndo.placement.header)})`,
        );
      }
      if (depthUndone !== depthBefore) {
        violations.push(
          `A14: after one undo the history is ${String(depthUndone)} deep, expected ${String(depthBefore)}`,
        );
      }
      if (afterUndo.ring.error !== null) {
        violations.push(`A14: after the undo ${afterUndo.ring.error}`);
      } else {
        // The ring springs from box to box by design (selection-ring.ts); what
        // L-90 forbids is a ring that keeps aiming at the OLD coordinates until
        // something re-tracks it. So: two frames after the undo it is already
        // travelling toward the moved icon, and with nothing else done it
        // lands on it.
        const ringBox = (region) => ({
          x: region.x - RING_PADDING,
          y: region.y - RING_PADDING,
          width: region.width + RING_PADDING * 2,
          height: region.height + RING_PADDING * 2,
        });
        const expected = ringBox(afterUndo.ring.region);
        if (Math.abs(afterUndo.ring.region.x - ringBefore.region.x) < 50) {
          violations.push(
            `A14: the undo did not move the selected icon (x ${ringBefore.region.x.toFixed(1)} -> ${afterUndo.ring.region.x.toFixed(1)}), so the ring's follow is untested`,
          );
        }
        const gapBefore = Math.abs(ringBefore.ring.x - expected.x);
        const gapAfter = Math.abs(afterUndo.ring.ring.x - expected.x);
        if (gapAfter > gapBefore - 5) {
          violations.push(
            `A14: two frames after the undo the ring is ${gapAfter.toFixed(1)}px from the moved icon, having been ${gapBefore.toFixed(1)}px away: it is not heading for the node (L-90)`,
          );
        }
        await delay(900);
        await flush(client);
        const landed = await evaluate(client, ringProbe("railBrowsers"));
        notes.push(
          `ring after it settles: ${landed.error ?? `${boxText(landed.ring)} on ${boxText(landed.region)}`}`,
        );
        if (landed.error !== null) {
          violations.push(`A14: once settled, ${landed.error}`);
        } else if (!sameBoxWithin(landed.ring, ringBox(landed.region), 1.5)) {
          violations.push(
            `A14: with nothing else done the ring settled at ${boxText(landed.ring)}, not on the moved icon's ring box ${boxText(ringBox(landed.region))} (L-90)`,
          );
        }
      }
    }
  }
  const errors = await evaluate(client, "window.__layoutCanvasErrors");
  if (errors.length > 0) {
    violations.push(
      `the fixture raised ${String(errors.length)} uncaught error(s):\n${errors.join("\n")}`,
    );
  }
  assertNoReloadSince(pageLoads, loadsAtStart, label, violations);
  console.log(`\n--- live placement switch ---`);
  for (const note of notes) console.log(`  ${note}`);
  assert.deepEqual(
    violations,
    [],
    `The live placement switch failed (${String(violations.length)}):\n${violations.map((line) => `  - ${line}`).join("\n")}`,
  );
  console.log(
    "live placement switch passed: a real click on Position Left moved the strip in one frame as one history step, and one undo restored the top, the selection ring heading for the moved node at once and landing on it with nothing re-tracked",
  );
}

const STRIP_PLACEMENT_PROBE = `(() => {
  const column = document.querySelector("[data-layout-column]");
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    placement: column === null ? null : column.getAttribute("data-tab-strip-placement"),
    column: box(column),
    strip: box(strip),
    header: document.querySelector("[data-fixture-header]") !== null,
  };
})()`;

// --- phase 3: the vertical strip's drag gesture (S-11) ----------------------

/** Past the tear-off threshold (24px) into the content, as the brief states it. */
const TEAR_OFF_PULL = 30;

async function runSideStripDragPhase(client, pageUrl, pageLoads) {
  const violations = [];
  const notes = [];
  for (const edge of ["left", "right"]) {
    const label = `strip drag ${edge}`;
    const loadsAtStart = await openVariant(
      client,
      variantUrl(pageUrl, { edge }),
      label,
      "window.__sideTabStripProbe?.ready === true && document.querySelectorAll('[data-strip-item-id]').length > 0",
      pageLoads,
    );
    const say = (line) => notes.push(`${edge}: ${line}`);
    const fail = (line) => violations.push(`${edge}: ${line}`);
    const initial = await evaluate(
      client,
      "window.__sideTabStripProbe.items()",
    );
    say(`seeded items ${JSON.stringify(initial)}`);

    // 1. Reorder along y: Epsilon up past Delta, with Delta stepping aside.
    await resetStrip(client);
    {
      const epsilon = await rowRect(client, "epic:fixture-epsilon");
      const delta = await rowRect(client, "epic:fixture-delta");
      const deltaFrame = await frameIdOf(client, "epic:fixture-delta");
      const target = { x: epsilon.cx, y: delta.cy - 8 };
      const mid = await dragRow(
        client,
        epsilon,
        target,
        `[data-strip-item-id="${deltaFrame}"]`,
      );
      const items = await evaluate(
        client,
        "window.__sideTabStripProbe.items()",
      );
      say(
        `reorder: mid-drag Delta frame transform "${String(mid.transform)}", overlay ${String(mid.overlay)}; items ${JSON.stringify(items)}`,
      );
      if (!mid.overlay)
        fail("reorder: no drag overlay while the row is in hand");
      if (translateY(mid.transform) <= 0) {
        fail(
          `reorder: Delta did not step aside mid-drag (its frame's transform is "${String(mid.transform)}")`,
        );
      }
      const order = items.map((keys) => keys.join("+"));
      if (
        order.indexOf("epic:fixture-epsilon") === -1 ||
        order.indexOf("epic:fixture-epsilon") >
          order.indexOf("epic:fixture-delta")
      ) {
        fail(
          `reorder: Epsilon is not before Delta after the drop: ${order.join(", ")}`,
        );
      }
    }

    // 2. A drop on a row's lower half pairs the two tabs into a split.
    await resetStrip(client);
    {
      const zeta = await rowRect(client, "epic:fixture-zeta");
      const epsilon = await rowRect(client, "epic:fixture-epsilon");
      const target = { x: zeta.cx, y: epsilon.cy + epsilon.height / 4 };
      const mid = await dragRow(client, zeta, target, null);
      const items = await evaluate(
        client,
        "window.__sideTabStripProbe.items()",
      );
      say(
        `pair: mid-drag preview ${String(mid.pairPreview)}; items ${JSON.stringify(items)}`,
      );
      if (mid.pairPreview === null)
        fail("pair: no pair preview on the hovered row's half mid-drag");
      const paired = items.some(
        (keys) =>
          keys.length === 2 &&
          keys.includes("epic:fixture-epsilon") &&
          keys.includes("epic:fixture-zeta"),
      );
      if (!paired)
        fail(
          `pair: dropping Zeta on Epsilon's lower half made no split of the two: ${JSON.stringify(items)}`,
        );
    }

    // 3. A split drags whole: the pair, grabbed by its top member, moves up
    // past Alpha as ONE item, and Alpha steps aside by the pair's extent. It
    // stays inside its group: a drop that would split a group is repaired
    // back by the layout (repairTabGroups), in both orientations.
    await resetStrip(client);
    {
      const beta = await rowRect(client, "epic:fixture-beta");
      const pair = await rectOf(client, '[data-strip-item-id="fixture-split"]');
      const alpha = await rowRect(client, "epic:fixture-alpha");
      const alphaFrame = await frameIdOf(client, "epic:fixture-alpha");
      const target = {
        x: beta.cx,
        y: beta.cy - (pair.y + pair.height / 2 - alpha.cy) - 10,
      };
      const mid = await dragRow(
        client,
        beta,
        target,
        `[data-strip-item-id="${alphaFrame}"]`,
      );
      const items = await evaluate(
        client,
        "window.__sideTabStripProbe.items()",
      );
      say(
        `split: pointer ${beta.cy.toFixed(0)} -> ${target.y.toFixed(0)}, overlay pair ${String(mid.overlayPair)}, Alpha frame "${String(mid.transform)}" (pair ${pair.height.toFixed(0)}px); items ${JSON.stringify(items)}`,
      );
      if (!mid.overlayPair) fail("split: the drag overlay is not the pair");
      const step = translateY(mid.transform);
      if (step < pair.height - 0.5) {
        fail(
          `split: Alpha stepped aside ${step.toFixed(1)}px mid-drag, less than the pair's ${pair.height.toFixed(1)}px, so the pair is not moving whole`,
        );
      }
      const order = items.map((keys) => keys.join("+"));
      if (
        order[0] !== "epic:fixture-beta+epic:fixture-gamma" ||
        order[1] !== "epic:fixture-alpha"
      ) {
        fail(
          `split: the pair did not land whole above Alpha: ${order.join(", ")}`,
        );
      }
    }

    // 4. Pulled sideways into the content: the preview, then a new window.
    await resetStrip(client);
    {
      const zeta = await rowRect(client, "epic:fixture-zeta");
      const strip = await rectOf(client, '[data-testid="side-tab-strip"]');
      const x =
        edge === "left"
          ? strip.x + strip.width + TEAR_OFF_PULL
          : strip.x - TEAR_OFF_PULL;
      const mid = await dragRow(client, zeta, { x, y: zeta.cy }, null);
      const requests = await evaluate(
        client,
        "window.__sideTabStripProbe.detachRequests()",
      );
      say(
        `tear-off into the content at x=${x.toFixed(0)}: preview ${String(mid.tearOff)}, requests ${JSON.stringify(requests)}`,
      );
      if (!mid.tearOff)
        fail(
          `tear-off: pulling ${String(TEAR_OFF_PULL)}px into the content showed no tear-off preview`,
        );
      if (!requests.includes("epic:fixture-zeta"))
        fail(
          "tear-off: releasing in the content requested no new window for Zeta",
        );
    }

    // 5. Pulled toward the window edge: nothing, until the pointer leaves the viewport.
    await resetStrip(client);
    {
      const zeta = await rowRect(client, "epic:fixture-zeta");
      const far = await rectOf(client, "[data-fixture-far-side]");
      const viewport = await evaluate(
        client,
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      const before = (
        await evaluate(client, "window.__sideTabStripProbe.detachRequests()")
      ).length;
      // As far toward the window edge as the viewport goes: 4px from it, which
      // is 44px past the band on the far side, beyond the 24px threshold.
      const farX = edge === "left" ? far.x + 4 : far.x + far.width - 4;
      const outsideX = edge === "left" ? -12 : viewport.width + 12;
      const trace = await dragRowVia(client, zeta, [
        { x: farX, y: zeta.cy },
        { x: outsideX, y: zeta.cy },
      ]);
      const requests = await evaluate(
        client,
        "window.__sideTabStripProbe.detachRequests()",
      );
      say(
        `toward the window edge: preview at the margin (x=${farX.toFixed(0)}) ${String(trace[0])}, outside the viewport (x=${String(outsideX)}) ${String(trace[1])}; requests ${JSON.stringify(requests.slice(before))}`,
      );
      if (trace[0])
        fail(
          "window edge: the pointer between the strip and the window edge already shows the tear-off preview",
        );
      if (!trace[1])
        fail(
          "window edge: the pointer outside the viewport shows no tear-off preview",
        );
      if (requests.length !== before + 1)
        fail(
          "window edge: releasing outside the viewport requested no new window",
        );
    }

    const errors = await evaluate(client, "window.__sideTabStripErrors");
    if (errors.length > 0)
      fail(
        `the fixture raised ${String(errors.length)} uncaught error(s):\n${errors.join("\n")}`,
      );
    assertNoReloadSince(pageLoads, loadsAtStart, label, violations);
  }
  console.log(`\n--- vertical strip drag ---`);
  for (const note of notes) console.log(`  ${note}`);
  assert.deepEqual(
    violations,
    [],
    `The vertical strip drag failed (${String(violations.length)}):\n${violations.map((line) => `  - ${line}`).join("\n")}`,
  );
  console.log(
    "vertical strip drag passed on both edges: y reorder with a neighbour stepping aside, a pair into a split, a split dragged whole, the tear-off into the content, and none toward the window edge until the pointer left the viewport",
  );
}

async function resetStrip(client) {
  await evaluate(client, "window.__sideTabStripProbe.reset()");
  await moveTo(client, 1, 1);
  await flush(client);
  await delay(250);
  await flush(client);
}

/** The row of one tab (`epic:<id>`), by its close button's test id. */
async function rowRect(client, key) {
  const [kind, id] = key.split(":");
  const box = await evaluate(
    client,
    `(() => {
      const close = document.querySelector('[data-testid="tab-close-${kind}-${id}"]');
      const row = close === null ? null : close.closest("[data-side-tab]");
      if (row === null) return null;
      const r = row.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    })()`,
  );
  if (box === null) throw new Error(`no row for ${key} in the strip`);
  return box;
}

async function frameIdOf(client, key) {
  const [kind, id] = key.split(":");
  return await evaluate(
    client,
    `document.querySelector('[data-testid="tab-close-${kind}-${id}"]')?.closest("[data-strip-item-id]")?.getAttribute("data-strip-item-id") ?? null`,
  );
}

const DRAG_STATE_PROBE = (siblingSelector) => `(() => {
  const sibling = ${siblingSelector === null ? "null" : `document.querySelector(${JSON.stringify(siblingSelector)})`};
  const overlay = document.querySelector('[data-testid="header-tab-drag-overlay"]');
  const preview = document.querySelector('[data-testid="side-tab-pair-preview"]');
  return {
    transform: sibling === null ? null : sibling.style.transform,
    overlay: overlay !== null,
    overlayPair: overlay !== null && overlay.querySelector('[data-testid^="split-tab-group-overlay-"]') !== null,
    pairPreview: preview === null ? null : preview.getAttribute("data-side"),
    tearOff: window.__sideTabStripProbe.tearOffPreview(),
  };
})()`;

async function dragRow(client, from, to, siblingSelector) {
  await pressAt(client, from.cx, from.cy);
  await moveInSteps(client, { x: from.cx, y: from.cy }, to);
  await delay(250);
  await flush(client);
  const mid = await evaluate(client, DRAG_STATE_PROBE(siblingSelector));
  await releaseAt(client, to.x, to.y);
  await delay(700);
  await flush(client);
  return mid;
}

/** A drag through several stops, reading the tear-off preview at each. */
async function dragRowVia(client, from, stops) {
  const seen = [];
  let at = { x: from.cx, y: from.cy };
  await pressAt(client, at.x, at.y);
  for (const stop of stops) {
    await moveInSteps(client, at, stop);
    at = stop;
    await delay(200);
    await flush(client);
    seen.push(
      await evaluate(client, "window.__sideTabStripProbe.tearOffPreview()"),
    );
  }
  await releaseAt(client, at.x, at.y);
  await delay(700);
  await flush(client);
  return seen;
}

async function pressAt(client, x, y) {
  await moveTo(client, x, y);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
}

async function moveInSteps(client, from, to) {
  // The page's own record of the last move it dispatched, so the wait below
  // can ask for the event itself rather than guess how long it takes.
  await evaluate(
    client,
    `window.__lastPointerMove ??= (() => {
      const last = { x: NaN, y: NaN };
      window.addEventListener("pointermove", (event) => {
        last.x = event.clientX;
        last.y = event.clientY;
      }, true);
      return last;
    })(); 0`,
  );
  const steps = 16;
  for (let step = 1; step <= steps; step += 1) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      button: "left",
      buttons: 1,
      clickCount: 0,
      pointerType: "mouse",
    });
  }
  await awaitPointerAt(client, to);
}

/**
 * Resolves once the page has DISPATCHED a move to `to`, not merely been sent
 * one. CDP answers a mouseMoved once the browser has taken it, while the
 * browser holds each move until the renderer acknowledges the previous one and
 * the renderer dispatches moves aligned to its next frame - so a read straight
 * after the last send could see the page one or more moves behind. Under load
 * that read the side strip at its 192px minimum instead of the rail its
 * crossing had already drawn. Checked once per frame: input is dispatched at
 * the start of a frame, before its rAF callbacks, so when a callback sees the
 * position every handler for that move has run.
 */
async function awaitPointerAt(client, to) {
  const found = await evaluate(
    client,
    `new Promise((resolve) => {
      const last = window.__lastPointerMove;
      let frames = 0;
      const check = () => {
        if (Math.abs(last.x - ${to.x}) <= 1 && Math.abs(last.y - ${to.y}) <= 1) resolve(true);
        else if (++frames > 600) resolve(false);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    })`,
  );
  if (!found)
    throw new Error(
      `the page never dispatched the move to (${String(to.x)}, ${String(to.y)})`,
    );
}

async function releaseAt(client, x, y) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
}

function translateY(transform) {
  if (typeof transform !== "string" || transform === "" || transform === "none")
    return 0;
  const match =
    /translateY\((-?[\d.]+)px\)|translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(
      transform,
    );
  if (match === null) return 0;
  return Number(match[1] ?? match[2]);
}

// --- the sheet shell: sheets, the joined tab, the rail, overlays, Activity, placement ---

/** The box the frame's margin and the sheets live in (`AppColumnFrame`). */
const SURFACE_FRAME = "[data-layout-column] main > div";

const SHELL_READY =
  "window.__layoutCanvasProbe?.ready === true && document.querySelector('[data-shell-sheet]') !== null";

/** Where the shell phases keep their screenshots, when the run asks for them. */
const SHOTS_DIR = process.env.LAYOUT_EDITOR_BROWSER_SHOTS ?? null;

/** The waiting pulse's ring spread (`side-strip-waiting-pulse` in index.css). */
const WAITING_PULSE_SPREAD = 8;

const NO_INDICATOR = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

/** One badge per kind (the rail expectations below). */
const RAIL_INDICATORS = {
  "fixture-alpha": { ...NO_INDICATOR, pendingApproval: true },
  "fixture-beta": { ...NO_INDICATOR, pendingInterview: true },
  "fixture-gamma": { ...NO_INDICATOR, unreadDone: true },
};

const RAIL_ACTIVITY = {
  "fixture-alpha": { working: ["a1"], turn: ["a1"] },
  "fixture-zeta": {
    working: ["z1", "z2", "z3", "z4", "z5"],
    turn: ["z1", "z2"],
  },
  "fixture-epsilon": {
    working: [
      "fixture-agent-plan",
      "fixture-agent-tests",
      "fixture-agent-index",
    ],
    turn: ["fixture-agent-plan", "fixture-agent-tests"],
  },
};

/**
 * The badge each tile draws from those; Delta's failure is the seed's local
 * notification. How many pips a meter draws, and its "+N", are
 * `agent-meter.test.tsx`'s: a count of nodes is not a layout question.
 */
const RAIL_EXPECTED = {
  AR: "approval",
  BR: "reply",
  GN: "unread",
  DM: "failed",
  EC: null,
  ZS: null,
};

async function saveShot(client, name) {
  if (SHOTS_DIR === null) return;
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await mkdir(SHOTS_DIR, { recursive: true });
  await writeFile(
    path.join(SHOTS_DIR, `${name}.png`),
    Buffer.from(shot.data, "base64"),
  );
}

/** A region's pixels as a flat rgb array, decoded in the page. */
async function regionPixels(client, x, y, width, height) {
  await ensurePixelTools(client);
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { x, y, width, height, scale: 1 },
    captureBeyondViewport: false,
  });
  return await evaluate(
    client,
    `window.__regionPixels(${JSON.stringify(shot.data)})`,
  );
}

function sameRgb(left, right, tolerance) {
  if (left === null || right === null) return false;
  return left.every(
    (channel, index) => Math.abs(channel - right[index]) <= tolerance,
  );
}

function rgbText(rgb) {
  return rgb === null ? "null" : `rgb(${rgb.join(",")})`;
}

async function settle(client, ms) {
  await flush(client);
  await delay(ms);
  await flush(client);
}

async function openShellVariant(client, pageUrl, pageLoads, query, label) {
  const loadsAtStart = await openVariant(
    client,
    variantUrl(pageUrl, query),
    label,
    SHELL_READY,
    pageLoads,
  );
  await evaluate(client, INSTALL_PIXEL_TOOLS);
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await moveTo(client, 1, 1);
  await settle(client, 350);
  return loadsAtStart;
}

async function closeShellVariant(
  client,
  pageLoads,
  loadsAtStart,
  label,
  violations,
) {
  const errors = await evaluate(client, "window.__layoutCanvasErrors");
  if (errors.length > 0) {
    violations.push(
      `${label}: the fixture raised ${String(errors.length)} uncaught error(s):\n${errors.join("\n")}`,
    );
  }
  assertNoReloadSince(pageLoads, loadsAtStart, label, violations);
}

/** Runs each variant, catching a stall as that variant's violation, then asserts the phase. */
async function runShellPhase(title, variants, run, summary) {
  const violations = [];
  const notes = [];
  for (const variant of variants) {
    try {
      await run(variant, violations, notes);
    } catch (error) {
      violations.push(
        `${variant.label}: stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`\n--- ${title} ---`);
  for (const note of notes) console.log(`  ${note}`);
  assert.deepEqual(
    violations,
    [],
    `The ${title} phase failed (${String(violations.length)}):\n${violations.map((line) => `  - ${line}`).join("\n")}`,
  );
  console.log(`${title} passed: ${summary}`);
}

// --- header: the top placement's tabs are boxes on the ground (staging round 1, F4) ---

/**
 * The top placement with the REAL `AppHeader` (`header=app`), on each window
 * chrome the header has to clear and with the panel on either side.
 */
const HEADER_VARIANTS = [
  {
    label: "no controls, sidebar left",
    query: { tabs: "top", wco: "none", sidebar: "left" },
  },
  {
    label: "no controls, sidebar right",
    query: { tabs: "top", wco: "none", sidebar: "right" },
  },
  {
    label: "macOS, sidebar left",
    query: { tabs: "top", wco: "mac", sidebar: "left" },
  },
  {
    label: "Windows, sidebar right",
    query: { tabs: "top", wco: "win", sidebar: "right" },
  },
];

/** The tab box: 32px, centred in the 40px header, on the sheets' own radius. */
const HEADER_TAB_BOX_HEIGHT = 32;

const HEADER_PROBE = (scope) => `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const radii = (node) => {
    const style = getComputedStyle(node);
    return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
  };
  const pseudo = (node) => [getComputedStyle(node, "::before").content, getComputedStyle(node, "::after").content].filter((value) => value !== "none" && value !== "normal");
  const header = document.querySelector('[data-testid="app-header"]');
  const strip = document.querySelector('[data-testid="tab-strip"]');
  const scope = ${scope};
  // In the strip, the selected tab's box; in a drag overlay, which has no tab
  // roles, the one box it draws.
  const activeItem = scope === null ? null : scope.matches('[data-testid="header-tab-drag-overlay"]')
    ? scope
    : scope.querySelector('[role="tab"][aria-selected="true"]');
  const activeBox = activeItem === null ? null : activeItem.matches('[data-testid="tab-chrome-box"]')
    ? activeItem
    : activeItem.querySelector('[data-testid="tab-chrome-box"]');
  const activeRoot = activeBox === null ? null : activeBox.parentElement;
  const sheet = document.querySelector('[data-epic-canvas-frame]');
  // Every painted part of the strip: nothing may reach below the header.
  const below = strip === null || header === null ? [] : [...strip.querySelectorAll("*")]
    .filter((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden";
    })
    .map((node) => ({ node, r: node.getBoundingClientRect() }))
    .filter(({ r }) => r.bottom > header.getBoundingClientRect().bottom + 0.5)
    .map(({ node, r }) => (node.getAttribute("data-testid") ?? node.tagName.toLowerCase()) + "@" + r.bottom.toFixed(1));
  return {
    header: box(header),
    frame: box(document.querySelector(${JSON.stringify(SURFACE_FRAME)})),
    sheet: box(sheet),
    active: box(activeBox),
    activeRadii: activeBox === null ? null : radii(activeBox),
    // The active tab opens into its task's sheet (the sheet join, index.css):
    // joined, its two bottom corners go square rather than matching the top.
    activeJoined: activeBox !== null && activeBox.hasAttribute("data-sheet-joined"),
    // A split pair joins as the GROUP's own box (split-tab-chrome.tsx), a
    // sibling of the focused member's chrome rather than a descendant of it:
    // the member's own box stays fully rounded and unjoined even while the
    // pair behind it fills the strip below with its sheet's fill instead of
    // ground. Search the whole strip item (data-strip-item-id, the lone
    // tab's own wrapper or the split group's) so either shape is found.
    itemJoined: activeBox !== null && activeBox.closest("[data-strip-item-id]")?.querySelector("[data-sheet-joined]") != null,
    activeBorder: activeBox === null ? null : getComputedStyle(activeBox).borderTopWidth,
    activePseudo: activeRoot === null ? [] : [...pseudo(activeRoot), ...pseudo(activeBox)],
    caps: document.querySelectorAll('[data-testid^="tab-cap"], [data-testid="tab-baseline-cover"]').length,
    newButton: box(document.querySelector('[data-testid="tab-new"]')),
    below,
    // A thin line wider than a tab's colour mark is a rule across a tab: the
    // folder-baseline language F4 retired.
    rules: strip === null ? [] : [...strip.querySelectorAll("*")]
      .map((node) => ({ node, r: node.getBoundingClientRect() }))
      .filter(({ node, r }) => r.height > 0 && r.height <= 3 && r.width > 32 && getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)")
      .map(({ node, r }) => (node.getAttribute("data-testid") ?? node.tagName.toLowerCase()) + " " + r.width.toFixed(0) + "x" + r.height.toFixed(1)),
  };
})()`;

async function runHeaderPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "header",
    HEADER_VARIANTS,
    async (variant, violations, notes) => {
      const label = `header ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          ...variant.query,
          collapsed: 0,
          dock: "right",
          surface: "epic",
          header: "app",
        },
        label,
      );
      const name = `header-${variant.query.wco}-${variant.query.sidebar}`;
      const strip = "document.querySelector('[data-testid=\"tab-strip\"]')";
      for (const theme of ["light", "dark"]) {
        await evaluate(
          client,
          `window.__layoutCanvasProbe.setTheme(${JSON.stringify(theme)})`,
        );
        await evaluate(
          client,
          'window.__layoutCanvasProbe.activateEpicTab("fixture-epsilon")',
        );
        await moveTo(client, 1, 1);
        await settle(client, 350);
        await saveShot(client, `${name}-${theme}`);
        const lone = await checkHeaderTabBox(
          client,
          strip,
          `${label}, ${theme}, lone tab`,
          null,
          violations,
          notes,
        );
        // An inactive tab's hover is the same box, without the border.
        const alpha = await rectOf(
          client,
          '[data-testid="tab-epic-fixture-alpha"]',
        );
        if (alpha === null) violations.push(`${label}: no Alpha tab`);
        else {
          await moveTo(client, alpha.cx, alpha.cy);
          await settle(client, 300);
          const hover = await evaluate(
            client,
            `(() => {
              const node = document.querySelector('[data-testid="tab-epic-fixture-alpha"] [data-testid="tab-hover-box"]');
              if (node === null) return null;
              const r = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return { y: r.y, height: r.height, radius: style.borderTopLeftRadius, opacity: style.opacity };
            })()`,
          );
          await saveShot(client, `${name}-${theme}-hover`);
          await moveTo(client, 1, 1);
          if (hover === null)
            violations.push(`${label}, ${theme}: Alpha draws no hover box`);
          else if (lone !== null) {
            notes.push(
              `${label}, ${theme}: hover box y ${hover.y.toFixed(1)} h ${hover.height.toFixed(1)} r ${hover.radius} opacity ${hover.opacity}`,
            );
            if (
              Math.abs(hover.y - lone.y) > 0.5 ||
              Math.abs(hover.height - lone.height) > 0.5 ||
              hover.radius !== lone.radius
            )
              violations.push(
                `${label}, ${theme}: the hover box (y ${hover.y.toFixed(1)}, h ${hover.height.toFixed(1)}, r ${hover.radius}) is not the active box's (y ${lone.y.toFixed(1)}, h ${lone.height.toFixed(1)}, r ${lone.radius})`,
              );
            if (!(Number.parseFloat(hover.opacity) > 0.9))
              violations.push(
                `${label}, ${theme}: the hover box is not shown under a real hover (opacity ${hover.opacity})`,
              );
          }
        }
        // The split pair's focused member is the same box.
        await evaluate(
          client,
          'window.__layoutCanvasProbe.activateStripItem("fixture-split")',
        );
        await settle(client, 350);
        await saveShot(client, `${name}-${theme}-split`);
        await checkHeaderTabBox(
          client,
          strip,
          `${label}, ${theme}, split pair`,
          lone,
          violations,
          notes,
        );
      }
      // The drag overlays wear the same box: a lone tab, then the pair.
      await evaluate(client, 'window.__layoutCanvasProbe.setTheme("dark")');
      await evaluate(
        client,
        'window.__layoutCanvasProbe.activateEpicTab("fixture-epsilon")',
      );
      await settle(client, 250);
      const reference = await checkHeaderTabBox(
        client,
        strip,
        `${label}, drag reference`,
        null,
        [],
        [],
      );
      // Each dragged while it is the active item, so its overlay draws a box.
      for (const [what, grab, activate] of [
        [
          "lone tab",
          '[data-testid="tab-epic-fixture-epsilon"]',
          'window.__layoutCanvasProbe.activateEpicTab("fixture-epsilon")',
        ],
        [
          "split pair",
          '[data-testid="tab-epic-fixture-beta"]',
          'window.__layoutCanvasProbe.activateStripItem("fixture-split")',
        ],
      ]) {
        await evaluate(client, activate);
        await settle(client, 250);
        const from = await rectOf(client, grab);
        if (from === null) {
          violations.push(`${label}: nothing to grab for the ${what} drag`);
          continue;
        }
        await headerDragHold(client, from, 48);
        await settle(client, 200);
        await saveShot(client, `${name}-drag-${what.replaceAll(" ", "-")}`);
        await checkHeaderTabBox(
          client,
          "document.querySelector('[data-testid=\"header-tab-drag-overlay\"]')",
          `${label}, ${what} drag overlay`,
          reference,
          violations,
          notes,
        );
        await headerDragReturn(client, from, 48);
        await settle(client, 300);
      }
      await evaluate(client, 'window.__layoutCanvasProbe.setTheme("system")');
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    `${String(HEADER_VARIANTS.length)} top-placement windows in both themes - the active tab, the split pair's focused member and both drag overlays are one ${String(HEADER_TAB_BOX_HEIGHT)}px box (self-consistent rounding on all four corners), centred in the header, with nothing of the strip below the header, ground under every box and the surface frame flush against the header's bottom edge; an inactive tab's real hover is the same box`,
  );
}

/**
 * The active box in `scope`, checked against the design and, with a
 * `reference`, against another box's geometry. Returns its y, height and
 * radius, or null when there is none.
 */
async function checkHeaderTabBox(
  client,
  scope,
  label,
  reference,
  violations,
  notes,
) {
  const probe = await evaluate(client, HEADER_PROBE(scope));
  const fail = (line) => violations.push(`${label}: ${line}`);
  if (probe.header === null || probe.sheet === null) {
    fail(
      `no header (${String(probe.header !== null)}) or content sheet (${String(probe.sheet !== null)})`,
    );
    return null;
  }
  if (probe.caps > 0)
    fail(
      `${String(probe.caps)} folder-tab cap or baseline cover(s) still drawn`,
    );
  if (probe.rules.length > 0)
    fail(
      `a thin rule runs across the strip instead of a short colour mark: ${probe.rules.join(", ")}`,
    );
  if (probe.below.length > 0)
    fail(
      `part of the tab strip reaches below the header (bottom ${probe.header.bottom.toFixed(1)}): ${probe.below.join(", ")}`,
    );
  if (probe.active === null) {
    fail("no active tab box");
    return null;
  }
  const active = probe.active;
  if (probe.activePseudo.length > 0)
    fail(
      `the active tab draws a pseudo-element (${probe.activePseudo.join(", ")})`,
    );
  if (Math.abs(active.height - HEADER_TAB_BOX_HEIGHT) > 0.5)
    fail(
      `the box is ${active.height.toFixed(1)}px tall, not ${String(HEADER_TAB_BOX_HEIGHT)}`,
    );
  if (probe.activeBorder !== "1px")
    fail(`the box's border is ${String(probe.activeBorder)}, not 1px`);
  // Flush surface: the sheets carry no radius of their own any more, so the
  // box's own rounding (design token, independent of the sheet below it) only
  // has to stay self-consistent - all four corners alike, unless the box is
  // joined into its sheet, which opens its two bottom corners square (the
  // sheet join, index.css) while the top two stay rounded alike.
  const [tl, tr, br, bl] = probe.activeRadii;
  if (probe.activeJoined) {
    if (tl !== tr)
      fail(`the box's top corners are ${tl} and ${tr}, not the same`);
    if (br !== "0px" || bl !== "0px")
      fail(
        `the box's joined bottom corners are ${br} and ${bl}, not square (0px)`,
      );
  } else if (new Set(probe.activeRadii).size !== 1) {
    fail(
      `the box's corners are ${probe.activeRadii.join(" ")}, not the same on all four`,
    );
  }
  const inOverlay = scope.includes("drag-overlay");
  if (!inOverlay) {
    if (Math.abs(active.cy - probe.header.cy) > 0.5)
      fail(
        `the box is not centred in the header: its centre ${active.cy.toFixed(1)}, the header's ${probe.header.cy.toFixed(1)}`,
      );
    if (
      probe.newButton !== null &&
      Math.abs(probe.newButton.cy - probe.header.cy) > 0.5
    )
      fail(
        `the new-tab button is not centred: ${probe.newButton.cy.toFixed(1)} against ${probe.header.cy.toFixed(1)}`,
      );
    if (active.bottom > probe.header.bottom || active.bottom > probe.sheet.y)
      fail(
        `the box reaches ${active.bottom.toFixed(1)}, past the header (${probe.header.bottom.toFixed(1)}) or into the sheet (${probe.sheet.y.toFixed(1)})`,
      );
    // Pixels: ground between the box and the header's own bottom edge - only
    // where the item is not joined (lone tab, or the pair's own group box).
    // A joined item's bridge fills that same strip with the sheet's own fill
    // instead (the sheet join, index.css).
    if (!probe.itemJoined) {
      const ground = await resolveRgb(client, "var(--shell-ground)");
      const y = active.bottom + 1.5;
      const pixel = await samplePixelAt(client, active.cx, y);
      if (!sameRgb(pixel, ground, 2))
        fail(
          `no ground between the box and the header's bottom (${active.cx.toFixed(0)}, ${y.toFixed(0)}): ${rgbText(pixel)}, ground ${rgbText(ground)}`,
        );
    }
    // Flush surface: the surface frame sits right at the header's own bottom
    // edge, with no shell gap between them any more.
    if (
      probe.frame !== null &&
      Math.abs(probe.frame.y - probe.header.bottom) > 0.5
    )
      fail(
        `the surface frame sits ${(probe.frame.y - probe.header.bottom).toFixed(1)}px off the header's bottom edge, not flush`,
      );
  }
  if (
    reference !== null &&
    (Math.abs(active.height - reference.height) > 0.5 ||
      probe.activeRadii[0] !== reference.radius ||
      (!inOverlay && Math.abs(active.y - reference.y) > 0.5))
  )
    fail(
      `the box (y ${active.y.toFixed(1)}, h ${active.height.toFixed(1)}, r ${probe.activeRadii[0]}) is not the lone active tab's (y ${reference.y.toFixed(1)}, h ${reference.height.toFixed(1)}, r ${reference.radius})`,
    );
  notes.push(
    `${label}: box ${boxText(active)} r ${probe.activeRadii[0]} in header ${boxText(probe.header)}, sheet top ${probe.sheet.y.toFixed(1)}`,
  );
  return { y: active.y, height: active.height, radius: probe.activeRadii[0] };
}

/** A real press on a header tab, dragged `dx` right and held (dnd-kit needs travel). */
async function headerDragHold(client, from, dx) {
  await moveTo(client, from.cx, from.cy);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.cx,
    y: from.cy,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
  for (let step = 1; step <= 16; step += 1) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.cx + (dx * step) / 16,
      y: from.cy,
      button: "left",
      buttons: 1,
      pointerType: "mouse",
    });
    await delay(16);
  }
}

/** Back to where the drag began, and released there, so nothing reorders. */
async function headerDragReturn(client, from, dx) {
  for (let step = 15; step >= 0; step -= 1) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.cx + (dx * step) / 16,
      y: from.cy,
      button: "left",
      buttons: 1,
      pointerType: "mouse",
    });
    await delay(16);
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: from.cx,
    y: from.cy,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
  await moveTo(client, 1, 1);
}

// --- running: the glyph set's running state is the app's AgentSpinningDots (staging round 1, F3) ---

/** `AgentSpinningDots`' default ("dots") frames: what a running agent shows everywhere. */
const RUNNING_DOTS_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** The tasks RAIL_ACTIVITY gives a live turn (Alpha, Zeta, Epsilon). */
const RUNNING_TURN_TASKS = Object.values(RAIL_ACTIVITY).filter(
  (entry) => entry.turn.length > 0,
).length;

const RUNNING_VARIANTS = [
  {
    label: "strip left, expanded",
    query: { tabs: "left", wco: "none", sidebar: "right", collapsed: 0 },
    expectGlyphs: true,
  },
  {
    label: "strip left, collapsed",
    query: { tabs: "left", wco: "none", sidebar: "right", collapsed: 1 },
    // The rail tile carries running work as meter pips (D5), not a glyph.
    expectGlyphs: false,
  },
  {
    label: "top header",
    query: {
      tabs: "top",
      wco: "none",
      sidebar: "left",
      collapsed: 0,
      header: "app",
    },
    expectGlyphs: true,
  },
];

const RUNNING_PROBE = `(() => {
  const scope = document.querySelector('[data-testid="side-tab-strip"]') ?? document.querySelector('[data-testid="tab-strip"]');
  if (scope === null) return { error: "no tab strip" };
  return {
    error: null,
    glyphs: [...scope.querySelectorAll('[data-status-glyph="running"]')].map((node) => {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        tag: node.tagName.toLowerCase(),
        svg: node.querySelector("svg") !== null || node.tagName.toLowerCase() === "svg",
        frame: node.textContent,
        visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0,
        // What assistive tech hears for it: the indicator's status name.
        status: node.closest('[role="status"]')?.getAttribute("aria-label") ?? null,
      };
    }),
    // The collapsed rail's tiles: running work is the meter's turn pips (D5),
    // and no spinner of any kind sits on a tile.
    tiles: [...scope.querySelectorAll('[data-side-tab="collapsed"][data-tile-kind="monogram"]')].map((tile) => ({
      name: (tile.querySelector('[data-testid="side-tab-monogram-chip"]')?.textContent ?? "").trim(),
      turnPips: tile.querySelectorAll('[data-testid="side-tab-meter"] [data-pip="turn"]').length,
      spinner: tile.querySelector('[data-status-glyph="running"], .font-mono') !== null,
    })),
  };
})()`;

/** Each motion preference the running phase runs under, set through CDP rather than inherited. */
const RUNNING_MOTION = ["no-preference", "reduce"];

async function emulateReducedMotion(client, value) {
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });
}

async function runRunningPhase(client, pageUrl, pageLoads) {
  try {
    await runShellPhase(
      "running",
      RUNNING_VARIANTS,
      async (variant, violations, notes) => {
        const label = `running ${variant.label}`;
        const loadsAtStart = await openShellVariant(
          client,
          pageUrl,
          pageLoads,
          { ...variant.query, dock: "right", surface: "epic" },
          label,
        );
        await evaluate(
          client,
          `window.__layoutCanvasProbe.setActivity(${JSON.stringify(RAIL_ACTIVITY)})`,
        );
        for (const motion of RUNNING_MOTION) {
          await emulateReducedMotion(client, motion);
          await checkRunning(
            client,
            variant,
            motion,
            `${label}, ${motion}`,
            violations,
            notes,
          );
        }
        await emulateReducedMotion(client, "");
        await closeShellVariant(
          client,
          pageLoads,
          loadsAtStart,
          label,
          violations,
        );
      },
      "the expanded strip and the top header draw running turns as AgentSpinningDots' default dots - advancing with motion, holding one visible frame under reduced motion with the same status name - and the collapsed rail shows them as turn pips with no spinner",
    );
  } finally {
    // Later phases must not inherit an emulated preference.
    await client.send("Emulation.setEmulatedMedia", {
      media: "",
      features: [],
    });
  }
}

async function checkRunning(client, variant, motion, label, violations, notes) {
  const fail = (line) => violations.push(`${label}: ${line}`);
  await settle(client, 350);
  await saveShot(
    client,
    `running-${variant.query.tabs}-${variant.query.collapsed === 1 ? "collapsed" : "expanded"}-${motion}`,
  );
  const probe = await evaluate(client, RUNNING_PROBE);
  // A second read a few ticks later: with motion it must have advanced, under
  // reduced motion it must be the same frame.
  await delay(250);
  const later = await evaluate(client, RUNNING_PROBE);
  if (probe.error !== null) {
    fail(probe.error);
    return;
  }
  if (later.error !== null || later.glyphs.length !== probe.glyphs.length) {
    fail(
      `the second sample is missing or differs in count (${later.error ?? `${String(later.glyphs.length)} vs ${String(probe.glyphs.length)}`})`,
    );
    return;
  }
  notes.push(
    `${label}: ${String(probe.glyphs.length)} running glyph(s) ${JSON.stringify(probe.glyphs)} -> ${JSON.stringify(later.glyphs.map((glyph) => glyph.frame))}`,
  );
  if (!variant.expectGlyphs) {
    // Every task RAIL_ACTIVITY gives a turn must carry turn pips on its tile,
    // so zero glyphs here is a claim about a drawn meter rather than about an
    // empty rail.
    const running = probe.tiles.filter((tile) => tile.turnPips > 0);
    notes.push(`${label}: tiles ${JSON.stringify(probe.tiles)}`);
    if (running.length < RUNNING_TURN_TASKS)
      fail(
        `${String(running.length)} tile(s) show turn pips, expected ${String(RUNNING_TURN_TASKS)} (${JSON.stringify(probe.tiles)})`,
      );
    for (const tile of probe.tiles.filter((entry) => entry.spinner))
      fail(
        `the ${tile.name} tile draws a spinner; the rail shows running work as meter pips`,
      );
  }
  if (variant.expectGlyphs && probe.glyphs.length === 0)
    fail("no running glyph on a strip whose tabs have running turns");
  probe.glyphs.forEach((glyph, index) => {
    const next = later.glyphs[index];
    if (
      glyph.svg ||
      glyph.frame.length !== 1 ||
      !RUNNING_DOTS_FRAMES.includes(glyph.frame)
    )
      fail(
        `a running glyph is not AgentSpinningDots' default dots (${JSON.stringify(glyph)})`,
      );
    if (!glyph.visible || !next.visible)
      fail(`a running glyph is not visible (${JSON.stringify(glyph)})`);
    if (glyph.status === null || next.status !== glyph.status)
      fail(
        `a running glyph's status name is missing or changed (${String(glyph.status)} -> ${String(next.status)})`,
      );
  });
  const frames = (read) => read.glyphs.map((glyph) => glyph.frame).join("");
  if (probe.glyphs.length === 0) return;
  if (motion === "no-preference" && frames(later) === frames(probe))
    fail(`the running dots did not advance in 250ms (${frames(probe)})`);
  if (motion === "reduce" && frames(later) !== frames(probe))
    fail(
      `the running dots moved under reduced motion (${frames(probe)} -> ${frames(later)})`,
    );
}

// --- sheets: the ground, four drawn corners, no pseudo arc, the handles in the gaps ---

const SHEET_VARIANTS = [
  {
    label: "left, sidebar left",
    query: { tabs: "left", wco: "none", sidebar: "left" },
  },
  {
    label: "right, sidebar right",
    query: { tabs: "right", wco: "none", sidebar: "right" },
  },
  {
    label: "left, macOS, sidebar right",
    query: { tabs: "left", wco: "mac", sidebar: "right" },
  },
  {
    label: "right, macOS, sidebar left",
    query: { tabs: "right", wco: "mac", sidebar: "left" },
  },
  {
    label: "top, sidebar left",
    query: { tabs: "top", wco: "none", sidebar: "left" },
  },
];

const SHEETS_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const frame = document.querySelector(${JSON.stringify(SURFACE_FRAME)});
  const pseudo = (node) => [getComputedStyle(node, "::before").content, getComputedStyle(node, "::after").content];
  const borders = (node) => {
    const style = getComputedStyle(node);
    return { top: style.borderTopWidth, right: style.borderRightWidth, bottom: style.borderBottomWidth, left: style.borderLeftWidth };
  };
  const radii = (node) => {
    const style = getComputedStyle(node);
    return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
  };
  const task = document.querySelector("[data-shell-sheet]");
  const panel = document.querySelector("[data-epic-sidebar-panel]");
  const canvas = document.querySelector("[data-epic-canvas-frame]");
  return {
    frame: box(frame),
    frameMargin: frame === null ? null : getComputedStyle(frame).margin,
    framePadding: frame === null ? null : getComputedStyle(frame).padding,
    framePseudo: frame === null ? [] : pseudo(frame),
    task: task === null ? null : task.getAttribute("data-shell-sheet"),
    panel: panel === null ? null : { rect: box(panel), border: borders(panel) },
    canvas: canvas === null ? null : { rect: box(canvas), border: borders(canvas), radii: radii(canvas), pseudo: pseudo(canvas) },
    strip: box(document.querySelector('[data-testid="side-tab-strip"]')),
    stripHandle: box(document.querySelector('[data-testid="side-tab-strip-resize-handle"]')),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

const HIT_PROBE = (x, y, selector) =>
  `document.elementFromPoint(${String(x)}, ${String(y)})?.closest(${JSON.stringify(selector)}) != null`;

/**
 * Mirrors `CanvasColumn`'s own seam suppression (epic-shell.tsx, flush
 * surface): the canvas frame leaves its border off the edge that already
 * carries the surface frame's own seam line (`data-tab-edge`) - only when
 * the tab strip sits directly against the canvas, i.e. the strip's edge
 * differs from the sidebar's side. `null` means every edge draws its border.
 */
function canvasSeamEdge(tabs, sidebarSide) {
  const stripEdge = tabs === "top" ? null : tabs;
  return stripEdge === sidebarSide ? null : stripEdge;
}

async function runSheetsPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "sheets",
    SHEET_VARIANTS,
    async (variant, violations, notes) => {
      const label = `sheets ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        { ...variant.query, collapsed: 0, dock: "right", surface: "epic" },
        label,
      );
      // Margins, borders, radii and hit targets: nothing here is themed.
      await checkSheets(client, variant, label, violations, notes);
      await saveShot(
        client,
        `sheets-${variant.query.tabs}-${variant.query.wco}-${variant.query.sidebar}`,
      );
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    `${String(SHEET_VARIANTS.length)} windows - the surface frame flush on every side (no margin, no padding), the panel with no border of its own, the canvas frame's border suppressed only on its own seam edge with no radius anywhere, and the width handles as the hit at the flush boundaries`,
  );
}

// --- flip: the panel and the content stay two sheets across a live side change ---

/**
 * Staging round 1, F2: moving the panel to the other side left the chat
 * drawn over the panel. A chat body is not inside the content sheet: the
 * `StableTileSurfaceHost` plane paints it at the rect its slot reports, and
 * the geometry coordinator only re-reads that rect on a SIZE change. A side
 * flip moves the content sheet without resizing it, so the body stayed at the
 * old x. Every tab placement, from each starting side (the load is what a
 * reload restores), then a live flip and a live flip back.
 */
const FLIP_VARIANTS = [
  { label: "tabs left, panel left", query: { tabs: "left", sidebar: "left" } },
  {
    label: "tabs left, panel right",
    query: { tabs: "left", sidebar: "right" },
  },
  {
    label: "tabs right, panel left",
    query: { tabs: "right", sidebar: "left" },
  },
  {
    label: "tabs right, panel right",
    query: { tabs: "right", sidebar: "right" },
  },
  { label: "tabs top, panel left", query: { tabs: "top", sidebar: "left" } },
  { label: "tabs top, panel right", query: { tabs: "top", sidebar: "right" } },
];

const FLIP_PROBE = `(() => {
  const box = (node) => {
    if (node === null || node === undefined) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const q = (selector) => document.querySelector(selector);
  // Whichever pane currently occupies the sidebar's screen position: the
  // real panel when expanded, or its collapsed rail (a separate element)
  // when not - the panel itself stays mounted at zero width while hidden.
  const sidebarPane = [
    q('[data-epic-sidebar-panel]'),
    q('[data-fixture-collapsed-rail]'),
  ].find((node) => node !== null && node.getBoundingClientRect().width > 0) ?? null;
  return {
    panel: box(sidebarPane),
    content: box(q('[data-epic-canvas-frame]')),
    slot: box(q('[data-testid="tile-surface-slot"]')),
    body: box(q("[data-fixture-hosted-body]")),
    stripHandle: box(q('[data-testid="side-tab-strip-resize-handle"]')),
    placement: q("[data-tab-strip-placement]")?.getAttribute("data-tab-strip-placement") ?? null,
    strip: (() => {
      const strip = q('[data-testid="side-tab-strip"]');
      if (strip === null) return null;
      return { edge: strip.getAttribute("data-edge"), collapsed: strip.getAttribute("data-collapsed"), rect: box(strip) };
    })(),
    rail: box(q("[data-fixture-collapsed-rail]")),
    panelWidth: q("[data-fixture-panel]")?.getBoundingClientRect().width ?? null,
  };
})()`;

async function runFlipPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "flip",
    FLIP_VARIANTS,
    async (variant, violations, notes) => {
      const label = `flip ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          ...variant.query,
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "epic",
        },
        label,
      );
      const from = variant.query.sidebar;
      const to = from === "left" ? "right" : "left";
      await checkFlip(client, from, `${label}, on load`, violations, notes);
      await saveShot(client, `flip-${variant.query.tabs}-${from}-load`);
      for (const [side, step] of [
        [to, "live flip"],
        [from, "live flip back"],
      ]) {
        await evaluate(
          client,
          `window.__layoutCanvasProbe.setSidebarSide(${JSON.stringify(side)})`,
        );
        await settle(client, 250);
        await checkFlip(client, side, `${label}, ${step}`, violations, notes);
        await saveShot(
          client,
          `flip-${variant.query.tabs}-${from}-${step.replaceAll(" ", "-")}`,
        );
      }
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    `${String(FLIP_VARIANTS.length)} windows - on load, after a live side flip and after flipping back, the panel sits flush on its side against the content frame (flush surface), and the hosted chat body fills its slot inside the content frame without touching the panel`,
  );
}

async function checkFlip(client, side, label, violations, notes) {
  const { panel, content, slot, body } = await evaluate(client, FLIP_PROBE);
  const fail = (line) => violations.push(`${label}: ${line}`);
  if (panel === null || content === null || slot === null || body === null) {
    fail(
      `a box is missing: panel ${String(panel !== null)}, content ${String(content !== null)}, slot ${String(slot !== null)}, hosted body ${String(body !== null)}`,
    );
    return;
  }
  const gap =
    side === "left" ? content.x - panel.right : panel.x - content.right;
  if (Math.abs(gap) > 0.5)
    fail(
      `the panel is not flush on the ${side} against the content frame (flush surface, no ground between them): gap ${gap.toFixed(1)}px (panel ${boxText(panel)}, content ${boxText(content)})`,
    );
  if (!sameBoxWithin(body, slot, 1))
    fail(
      `the hosted chat body is not on its slot: body ${boxText(body)}, slot ${boxText(slot)}`,
    );
  const overlapX =
    Math.min(body.right, panel.right) - Math.max(body.x, panel.x);
  const overlapY =
    Math.min(body.bottom, panel.bottom) - Math.max(body.y, panel.y);
  if (overlapX > 0 && overlapY > 0)
    fail(
      `the hosted chat body overlays the panel by ${overlapX.toFixed(0)}x${overlapY.toFixed(0)}px (body ${boxText(body)}, panel ${boxText(panel)})`,
    );
  if (
    body.x < content.x - 1 ||
    body.right > content.right + 1 ||
    body.y < content.y - 1 ||
    body.bottom > content.bottom + 1
  )
    fail(
      `the hosted chat body leaves the content sheet: body ${boxText(body)}, content ${boxText(content)}`,
    );
  notes.push(
    `${label}: panel ${boxText(panel)}, content ${boxText(content)}, body ${boxText(body)}`,
  );
}

// --- moves: every other layout change that moves or resizes the chat's slot ---

/**
 * The sibling sweep of F2: every other live change that moves the content
 * sheet, with the hosted chat open. A strip side switch shifts the whole
 * surface by the strip's width, with the content keeping its width; top and
 * side trade the header for the strip; the strip's collapse and width drag and
 * the panel's collapse to its rail resize the content. After each, the same
 * assertions as the flip.
 */
const MOVE_VARIANTS = [
  { label: "panel left", sidebar: "left" },
  { label: "panel right", sidebar: "right" },
];

/** How far the moves phase drags the strip's width handle, and the slack on the width it lands at. */
const STRIP_DRAG_PX = 60;
const STRIP_DRAG_SLACK = 2;

/** The content sheet widened (or narrowed) by what the column beside it gave up (or took). */
function contentAbsorbed(columnBefore, columnAfter, before, after, what) {
  const given = columnBefore - columnAfter;
  const grown = after.content.width - before.content.width;
  if (Math.abs(given) <= 1)
    return [
      `${what} did not change width (${columnBefore.toFixed(1)} -> ${columnAfter.toFixed(1)}px)`,
    ];
  if (Math.abs(grown - given) > 1)
    return [
      `the content sheet changed width by ${grown.toFixed(1)}px, not the ${given.toFixed(1)}px ${what} gave up`,
    ];
  return [];
}

function movedTabsTo(edge, before, after) {
  const problems = [];
  if (after.placement !== edge)
    problems.push(
      `the column's placement is ${String(after.placement)}, expected ${edge}`,
    );
  if (edge === "top" && after.strip !== null)
    problems.push(
      `a side strip is still drawn on the ${String(after.strip.edge)}`,
    );
  if (edge !== "top" && after.strip?.edge !== edge)
    problems.push(
      `the strip is on ${String(after.strip?.edge ?? "no edge")}, expected ${edge}`,
    );
  if (sameBoxWithin(before.content, after.content, 0.5))
    problems.push(
      `the content sheet did not move or resize (${boxText(after.content)})`,
    );
  return problems;
}

function stripCollapsedTo(collapsed, before, after) {
  if (before.strip === null || after.strip === null)
    return ["no side strip to collapse"];
  const problems = [];
  if (after.strip.collapsed !== String(collapsed))
    problems.push(
      `the strip's data-collapsed is ${String(after.strip.collapsed)}, expected ${String(collapsed)}`,
    );
  if (
    collapsed &&
    Math.abs(after.strip.rect.width - SIDE_STRIP_RAIL_WIDTH) > 0.5
  )
    problems.push(
      `the collapsed strip is ${after.strip.rect.width.toFixed(1)}px, not the ${String(SIDE_STRIP_RAIL_WIDTH)}px rail`,
    );
  return [
    ...problems,
    ...contentAbsorbed(
      before.strip.rect.width,
      after.strip.rect.width,
      before,
      after,
      "the strip",
    ),
  ];
}

function stripDraggedWider(before, after) {
  if (
    before.strip === null ||
    after.strip === null ||
    before.stripHandle === null
  )
    return ["no side strip or width handle to drag"];
  const widened = after.strip.rect.width - before.strip.rect.width;
  const problems = [];
  if (Math.abs(widened - STRIP_DRAG_PX) > STRIP_DRAG_SLACK)
    problems.push(
      `the strip widened ${widened.toFixed(1)}px for a ${String(STRIP_DRAG_PX)}px drag`,
    );
  return [
    ...problems,
    ...contentAbsorbed(
      before.strip.rect.width,
      after.strip.rect.width,
      before,
      after,
      "the strip",
    ),
  ];
}

function panelCollapsedTo(collapsed, before, after) {
  if (before.panel === null || after.panel === null)
    return ["no panel sheet on screen"];
  const problems = [];
  if (
    collapsed &&
    (after.rail === null ||
      Math.abs(after.rail.width - PANEL_RAIL_SHEET_WIDTH) > 0.5)
  )
    problems.push(
      `no ${String(PANEL_RAIL_SHEET_WIDTH)}px rail sheet (${after.rail === null ? "none" : boxText(after.rail)})`,
    );
  if (collapsed && after.panelWidth !== 0)
    problems.push(`the panel is still ${String(after.panelWidth)}px wide`);
  if (!collapsed && after.rail !== null)
    problems.push(`the rail sheet is still drawn at ${boxText(after.rail)}`);
  if (!collapsed && (after.panelWidth ?? 0) <= PANEL_RAIL_SHEET_WIDTH)
    problems.push(
      `the panel is ${String(after.panelWidth)}px wide, not expanded`,
    );
  return [
    ...problems,
    ...contentAbsorbed(
      before.panel.width,
      after.panel.width,
      before,
      after,
      "the panel column",
    ),
  ];
}

async function runMovesPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "moves",
    MOVE_VARIANTS,
    async (variant, violations, notes) => {
      const label = `moves ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          tabs: "left",
          sidebar: variant.sidebar,
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "epic",
        },
        label,
      );
      // Each step first proves it happened - the destination is on screen and
      // the content sheet's box changed the way that move changes it - so a
      // move that silently did nothing cannot pass on the unchanged geometry.
      const step = async (name, act, expect) => {
        const before = await evaluate(client, FLIP_PROBE);
        await act();
        await settle(client, 300);
        const after = await evaluate(client, FLIP_PROBE);
        for (const problem of expect(before, after))
          violations.push(`${label}, ${name}: ${problem}`);
        await checkFlip(
          client,
          variant.sidebar,
          `${label}, ${name}`,
          violations,
          notes,
        );
      };
      const call = (expression) => () =>
        evaluate(client, `window.__layoutCanvasProbe.${expression}`);
      for (const [from, to] of [
        ["left", "right"],
        ["right", "left"],
        ["left", "top"],
        ["top", "right"],
        ["right", "top"],
        ["top", "left"],
      ]) {
        await step(
          `tabs ${from} to ${to}`,
          call(`setTabPlacement(${JSON.stringify(to)})`),
          (before, after) => movedTabsTo(to, before, after),
        );
      }
      await step("strip collapsed", call("setCollapsed(true)"), (b, a) =>
        stripCollapsedTo(true, b, a),
      );
      await step("strip expanded", call("setCollapsed(false)"), (b, a) =>
        stripCollapsedTo(false, b, a),
      );
      await step(
        `strip dragged ${String(STRIP_DRAG_PX)}px wider`,
        async () => {
          const { stripHandle } = await evaluate(client, FLIP_PROBE);
          if (stripHandle === null) return;
          const from = {
            x: stripHandle.x + stripHandle.width / 2,
            y: stripHandle.y + stripHandle.height / 2,
          };
          const to = { x: from.x + STRIP_DRAG_PX, y: from.y };
          await pressAt(client, from.x, from.y);
          await moveInSteps(client, from, to);
          await releaseAt(client, to.x, to.y);
        },
        stripDraggedWider,
      );
      await step(
        "panel collapsed to its rail",
        call("setPanelCollapsed(true)"),
        (b, a) => panelCollapsedTo(true, b, a),
      );
      await saveShot(client, `moves-${variant.sidebar}-panel-collapsed`);
      await step("panel expanded", call("setPanelCollapsed(false)"), (b, a) =>
        panelCollapsedTo(false, b, a),
      );
      await saveShot(client, `moves-${variant.sidebar}-end`);
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "on both panel sides, after a strip side switch each way, top to each side and back, a strip collapse and expand, a strip width drag, and the panel collapsing to its rail and back, the hosted chat body stays on its slot inside the content frame, flush against the panel",
  );
}

async function checkSheets(client, variant, label, violations, notes) {
  const probe = await evaluate(client, SHEETS_PROBE);
  const fail = (line) => violations.push(`${label}: ${line}`);
  if (probe.frameMargin !== "0px")
    fail(
      `the surface frame's margin is ${probe.frameMargin}, not flush (0px, flush surface)`,
    );
  if (probe.framePadding !== "0px")
    fail(`the surface frame's padding is ${probe.framePadding}, not 0px`);
  if (probe.framePseudo.some((content) => content !== "none"))
    fail(
      `the surface frame still draws a pseudo-element (${probe.framePseudo.join(", ")}): there is no radius left to carve an arc out of`,
    );
  if (probe.task !== "task")
    fail(
      `expected one task sheet (data-shell-sheet="task"), found ${probe.task === null ? "none" : probe.task}`,
    );
  if (probe.panel === null || probe.canvas === null) {
    fail(
      `the panel (${String(probe.panel !== null)}) or the canvas frame (${String(probe.canvas !== null)}) is missing`,
    );
    return;
  }
  // No pane divider left on the panel: only the canvas frame draws a border now.
  for (const [side, width] of Object.entries(probe.panel.border)) {
    if (width !== "0px")
      fail(`the panel still draws a ${side} border (${width})`);
  }
  // No sheet radius anywhere: the canvas frame is a plain rectangle.
  if (probe.canvas.radii.some((radius) => radius !== "0px"))
    fail(
      `the canvas frame has a corner radius (${probe.canvas.radii.join(" ")}), expected none`,
    );
  if (probe.canvas.pseudo.some((content) => content !== "none"))
    fail(
      `the canvas frame draws a pseudo-element (${probe.canvas.pseudo.join(", ")})`,
    );
  // The canvas frame's border is suppressed only on the edge that already
  // carries the surface frame's own seam line (where the canvas meets the
  // strip directly); it is drawn everywhere else, including against the panel.
  const seam = canvasSeamEdge(variant.query.tabs, variant.query.sidebar);
  for (const side of ["left", "right"]) {
    const width = probe.canvas.border[side];
    if (side === seam) {
      if (width !== "0px")
        fail(
          `the canvas frame still draws its ${side} border (${width}) where the surface frame's own seam already runs`,
        );
    } else if (width !== "1px") {
      fail(`the canvas frame's ${side} border is ${width}, not 1px`);
    }
  }
  // Flush: the panel and the canvas frame touch with nothing between them.
  const [left, right] =
    probe.panel.rect.x < probe.canvas.rect.x
      ? [probe.panel.rect, probe.canvas.rect]
      : [probe.canvas.rect, probe.panel.rect];
  const gap = right.x - (left.x + left.width);
  if (Math.abs(gap) > 0.5)
    fail(
      `the panel and the canvas frame are ${gap.toFixed(1)}px apart, not flush (panel ${boxText(probe.panel.rect)}, canvas ${boxText(probe.canvas.rect)})`,
    );
  const gapX = (left.x + left.width + right.x) / 2;
  const midY = probe.canvas.rect.y + probe.canvas.rect.height * 0.75;
  // The frame itself is flush to the window on whichever edge has no strip:
  // no ground left outside it any more.
  if (probe.strip === null || probe.strip.x > probe.frame.x) {
    if (Math.abs(probe.frame.x) > 0.5)
      fail(
        `the surface frame sits ${probe.frame.x.toFixed(1)}px off the window's left edge, not flush`,
      );
  }
  if (probe.strip === null || probe.strip.x < probe.frame.x) {
    const edgeGap = probe.viewport.width - (probe.frame.x + probe.frame.width);
    if (Math.abs(edgeGap) > 0.5)
      fail(
        `the surface frame sits ${edgeGap.toFixed(1)}px off the window's right edge, not flush`,
      );
  }
  // The handles are still the hit at the boundary they sit on, now flush
  // rather than centred in a ground gap.
  if (
    !(await evaluate(
      client,
      HIT_PROBE(gapX, midY, '[data-testid="epic-sidebar-resize-handle"]'),
    ))
  )
    fail(
      `the boundary between the panel and the canvas at x=${gapX.toFixed(1)} is not the panel's width handle`,
    );
  if (probe.strip !== null) {
    const stripGapX =
      probe.strip.x < probe.frame.x
        ? (probe.strip.x + probe.strip.width + probe.frame.x) / 2
        : (probe.frame.x + probe.frame.width + probe.strip.x) / 2;
    if (
      !(await evaluate(
        client,
        HIT_PROBE(
          stripGapX,
          midY,
          '[data-testid="side-tab-strip-resize-handle"]',
        ),
      ))
    )
      fail(
        `the boundary between the strip and the frame at x=${stripGapX.toFixed(1)} is not the strip's width handle`,
      );
  }
  notes.push(
    `${label}: canvas border ${JSON.stringify(probe.canvas.border)}, seam ${String(seam)}`,
  );
}

// --- the joined tab (D3) and its four T05 risks ---

const JOIN_VARIANTS = [
  {
    label: "left, sidebar left",
    query: { tabs: "left", sidebar: "left", surface: "epic" },
    joins: "left",
    pane: "panel",
  },
  {
    label: "right, sidebar right",
    query: { tabs: "right", sidebar: "right", surface: "epic" },
    joins: "right",
    pane: "panel",
  },
  {
    // The panel sits on the strip's far side here, so the strip meets the
    // canvas directly: `useSideTabJoin` still joins, with the canvas as the
    // pane (side-tab-join.ts - "the panel on the far side" is explicitly one
    // of the cases the canvas pane covers), rather than joining nothing.
    label: "left, sidebar right",
    query: { tabs: "left", sidebar: "right", surface: "epic" },
    joins: "left",
    pane: "canvas",
  },
  {
    label: "left, sidebar left, a route surface",
    query: { tabs: "left", sidebar: "left", surface: "sample" },
    joins: null,
  },
];

/** The join's own `--join-fill` token per pane (index.css). */
function paneFillToken(pane) {
  if (pane === "panel") return "--sidebar";
  if (pane === "rail") return "--background";
  return "--canvas";
}

const JOIN_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const joined = document.querySelector("[data-sheet-joined]");
  const bridge = document.querySelector("[data-sheet-join-bridge]");
  const active = document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]');
  const list = document.querySelector('[data-testid="side-tab-strip"] [data-strip-axis="y"]');
  // Whichever pane currently occupies the sidebar's screen position: the
  // real panel when expanded, or its collapsed rail (a separate element,
  // the join's "rail" pane) when not.
  const sidebarPane = [
    document.querySelector('[data-epic-sidebar-panel]'),
    document.querySelector('[data-fixture-collapsed-rail]'),
  ].find((node) => node !== null && node.getBoundingClientRect().width > 0) ?? null;
  return {
    joined: joined === null ? null : { edge: joined.getAttribute("data-sheet-joined"), pane: joined.getAttribute("data-join-pane"), rect: box(joined), text: joined.textContent.trim() },
    bridge: bridge === null || getComputedStyle(bridge).display === "none" ? null : box(bridge),
    active: box(active),
    list: box(list),
    panel: box(sidebarPane),
    canvas: box(document.querySelector('[data-epic-canvas-frame]')),
    strip: box(document.querySelector('[data-testid="side-tab-strip"]')),
    handle: box(document.querySelector('[data-testid="side-tab-strip-resize-handle"]')),
  };
})()`;

async function runJoinPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "joined tab",
    JOIN_VARIANTS,
    async (variant, violations, notes) => {
      const label = `join ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        { ...variant.query, collapsed: 0, wco: "none", dock: "right" },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);
      if (variant.joins === null) {
        const probe = await evaluate(client, JOIN_PROBE);
        if (probe.joined !== null)
          fail(
            `a row is joined (${probe.joined.edge}) where the predicate does not hold`,
          );
        if (probe.bridge !== null)
          fail(
            `the bridge paints at ${boxText(probe.bridge)} with nothing joined`,
          );
        say(
          `nothing joined, bridge ${probe.bridge === null ? "hidden" : "shown"}`,
        );
      } else {
        await checkJoinPaint(client, variant, "expanded", fail, say);
        await checkJoinOverHandle(client, variant, fail, say);
        await checkJoinScrolledOut(client, variant, fail, say);
        await evaluate(client, "window.__layoutCanvasProbe.setCollapsed(true)");
        await settle(client, 400);
        await checkJoinPaint(client, variant, "collapsed", fail, say);
        await evaluate(
          client,
          "window.__layoutCanvasProbe.setCollapsed(false)",
        );
        await settle(client, 400);
        await checkJoinAfterReorder(client, variant, fail, say);
      }
      await saveShot(
        client,
        `join-${variant.query.tabs}-${variant.query.sidebar}-${variant.query.surface}`,
      );
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "the active row and tile take the panel's fill and run it over the seam onto the frame on both edges, the fill stays inside the joined shape past its corners, nothing joins on the far side or over a route, and the bridge holds over the resize handle, after a reorder settles, and gives way while its row is scrolled part out",
  );
}

/** J1-J3: the row, the bridge over the gap and the sheet's border, and containment past the corner. */
async function checkJoinPaint(client, variant, state, fail, say) {
  const probe = await evaluate(client, JOIN_PROBE);
  if (probe.joined === null) {
    fail(`${state}: no row or tile is joined`);
    return;
  }
  if (probe.joined.edge !== variant.joins)
    fail(
      `${state}: the joined row is open to the ${probe.joined.edge}, expected ${variant.joins}`,
    );
  if (probe.bridge === null) {
    fail(`${state}: the bridge is not painting`);
    return;
  }
  const row = probe.joined.rect;
  // The pane the row joins: the panel (or its collapsed rail) when the
  // sidebar sits on the strip's own side, else the canvas - whichever pane
  // actually sits flush against the strip (side-tab-join.ts).
  const pane = probe.joined.pane === "canvas" ? probe.canvas : probe.panel;
  if (pane === null) {
    fail(`${state}: no ${probe.joined.pane} pane on screen to join`);
    return;
  }
  // The join's own fill token (index.css), not a sampled pixel: the canvas
  // pane is mostly covered by hosted content in this fixture, so a pixel
  // sample would read the content's fill rather than the pane's own.
  const fill = await resolveRgb(
    client,
    `var(${paneFillToken(probe.joined.pane)})`,
  );
  const onLeft = variant.joins === "left";
  const rowEnd = onLeft ? row.x + row.width - 2 : row.x + 2;
  const gapX = onLeft
    ? (probe.strip.x + probe.strip.width + pane.x) / 2
    : (pane.x + pane.width + probe.strip.x) / 2;
  const borderX = onLeft ? pane.x + 0.5 : pane.x + pane.width - 0.5;
  const spots = {
    "the row's sheet-side end": [rowEnd, row.cy],
    "the gap": [gapX, row.cy],
    // The canvas pane is filled edge to edge by the fixture's own hosted
    // demo content (a dashed border right at its own edge), which the gap
    // spot above already sits just outside of; sampling the seam border
    // itself would read that demo border instead. Panel/rail stay blank
    // there, so the check still holds for them.
    ...(probe.joined.pane === "canvas"
      ? {}
      : { "the sheet's border": [borderX, row.cy] }),
  };
  for (const [where, [x, y]] of Object.entries(spots)) {
    const pixel = await samplePixelAt(client, x, y);
    if (!sameRgb(pixel, fill, 3))
      fail(
        `${state}: ${where} at (${x.toFixed(1)}, ${y.toFixed(0)}) is ${rgbText(pixel)}, not the ${variant.pane}'s fill ${rgbText(fill)}`,
      );
  }
  // Past the concave corners the join's fill does not bleed: the strip's own
  // background shows again above and below the joined row.
  for (const y of [row.y - 10, row.y + row.height + 10]) {
    const pixel = await samplePixelAt(client, gapX, y);
    if (sameRgb(pixel, fill, 3))
      fail(
        `${state}: the gap ${y < row.y ? "above" : "below"} the join (y=${y.toFixed(0)}) still reads as the joined fill ${rgbText(fill)}, past the row's own bounds`,
      );
  }
  if (
    Math.abs(probe.bridge.y - row.y) > 0.5 ||
    Math.abs(probe.bridge.height - row.height) > 0.5
  )
    fail(
      `${state}: the bridge ${boxText(probe.bridge)} is not level with its row ${boxText(row)}`,
    );
  say(
    `${state}: "${probe.joined.text}" joined ${probe.joined.edge}, fill ${rgbText(fill)} across the gap and the border, bridge ${boxText(probe.bridge)}`,
  );
}

/** The handle's hover line is drawn under the bridge, and the handle still takes the pointer there. */
async function checkJoinOverHandle(client, variant, fail, say) {
  const before = await evaluate(client, JOIN_PROBE);
  const row = before.joined.rect;
  const x = before.handle.cx;
  const fill = await resolveRgb(
    client,
    `var(${paneFillToken(before.joined.pane)})`,
  );
  await moveTo(client, x, row.cy);
  await settle(client, 400);
  const hovered = await evaluate(
    client,
    `document.querySelector('[data-testid="side-tab-strip-resize-handle"]').matches(":hover")`,
  );
  const pixel = await samplePixelAt(client, x, row.cy);
  await saveShot(client, `join-handle-${variant.joins}`);
  await moveTo(client, 1, 1);
  await settle(client, 200);
  if (!hovered)
    fail("the resize handle is not the hit where the bridge crosses it");
  if (!sameRgb(pixel, fill, 3))
    fail(
      `the hovered handle's line cuts the joined band at x=${x.toFixed(1)}: ${rgbText(pixel)}, fill ${rgbText(fill)}`,
    );
  say(`handle hovered under the bridge: ${rgbText(pixel)}`);
}

/** A row part out of the list is a plain active row, so the bridge never paints over the chrome around the list. */
async function checkJoinScrolledOut(client, variant, fail, say) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 340,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    await settle(client, 300);
    const overflow = await evaluate(
      client,
      `(() => { const list = document.querySelector('[data-testid="side-tab-strip"] [data-strip-axis="y"]'); return list.scrollHeight - list.clientHeight; })()`,
    );
    if (overflow < 40) {
      fail(
        `the row list does not overflow at 340px (${String(overflow)}px), so the scrolled-out case is not measured`,
      );
      return;
    }
    // Half of the active row past the list's bottom edge, beside the foot.
    await evaluate(
      client,
      `(() => {
      const list = document.querySelector('[data-testid="side-tab-strip"] [data-strip-axis="y"]');
      const row = document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]');
      const r = row.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      list.scrollTop += r.y + r.height / 2 - (l.y + l.height);
    })()`,
    );
    await settle(client, 300);
    const cut = await evaluate(client, JOIN_PROBE);
    await saveShot(client, `join-scrolled-out-${variant.joins}`);
    if (cut.joined !== null)
      fail(
        `a row cut by the list's edge is still joined (row ${boxText(cut.joined.rect)}, list ${boxText(cut.list)})`,
      );
    if (cut.bridge !== null)
      fail(
        `the bridge paints at ${boxText(cut.bridge)} for a row cut by the list's edge`,
      );
    const pane = variant.pane === "canvas" ? cut.canvas : cut.panel;
    const gapX =
      variant.joins === "left"
        ? (cut.strip.x + cut.strip.width + pane.x) / 2
        : (pane.x + pane.width + cut.strip.x) / 2;
    const fill = await resolveRgb(
      client,
      `var(${paneFillToken(variant.pane)})`,
    );
    const listBottom = cut.list.y + cut.list.height;
    const cutRow = await evaluate(
      client,
      `(() => { const r = document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]').getBoundingClientRect(); return { y: r.y, bottom: r.y + r.height }; })()`,
    );
    if (!(cutRow.y < listBottom && cutRow.bottom > listBottom))
      fail(
        `the active row [${cutRow.y.toFixed(0)}, ${cutRow.bottom.toFixed(0)}] is not cut by the list's bottom edge at ${listBottom.toFixed(0)}`,
      );
    // A row cut by the list's edge is unjoined (checked above): its would-be
    // fill does not bleed into the strip's own chrome around the list.
    for (const [where, y] of [
      ["beside the row's visible half", listBottom - 4],
      ["beside the foot", listBottom + 4],
    ]) {
      const pixel = await samplePixelAt(client, gapX, y);
      if (sameRgb(pixel, fill, 3))
        fail(
          `the gap ${where} (y=${y.toFixed(0)}) reads as the pane's fill ${rgbText(fill)}, but nothing should be joined here`,
        );
    }
    await evaluate(
      client,
      `document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]').scrollIntoView({ block: "nearest" })`,
    );
    await settle(client, 300);
    const back = await evaluate(client, JOIN_PROBE);
    if (back.joined === null || back.bridge === null)
      fail("the row did not join again once wholly back in the list");
    say(
      `list overflow ${String(overflow)}px: joined while cut ${String(cut.joined !== null)}, joined once back in view ${String(back.joined !== null)}`,
    );
  } finally {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1500,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle(client, 300);
  }
}

/** The bridge is level with its row once a reorder that moved it has settled. */
async function checkJoinAfterReorder(client, variant, fail, say) {
  const epsilon = await rowRect(client, "epic:fixture-epsilon");
  const delta = await rowRect(client, "epic:fixture-delta");
  await pressAt(client, epsilon.cx, epsilon.cy);
  await moveInSteps(
    client,
    { x: epsilon.cx, y: epsilon.cy },
    { x: epsilon.cx, y: delta.cy - 8 },
  );
  await delay(250);
  await releaseAt(client, epsilon.cx, delta.cy - 8);
  await settle(client, 900);
  const probe = await evaluate(client, JOIN_PROBE);
  const moved = await rowRect(client, "epic:fixture-epsilon");
  if (moved.y >= epsilon.y - 1)
    fail(
      `the reorder did not move Epsilon (${epsilon.y.toFixed(0)} -> ${moved.y.toFixed(0)})`,
    );
  if (probe.joined === null || probe.bridge === null) {
    fail("after the reorder nothing is joined");
    return;
  }
  if (
    Math.abs(probe.bridge.y - probe.joined.rect.y) > 0.5 ||
    Math.abs(probe.bridge.height - probe.joined.rect.height) > 0.5
  )
    fail(
      `after the reorder settled the bridge ${boxText(probe.bridge)} is not level with its row ${boxText(probe.joined.rect)}`,
    );
  await saveShot(client, `join-after-reorder-${variant.joins}`);
  say(
    `reorder: Epsilon ${epsilon.y.toFixed(0)} -> ${moved.y.toFixed(0)}, bridge ${boxText(probe.bridge)}`,
  );
}

// --- the rail: 60px, the meter, the badge per state; the pulse unclipped ---

async function runRailPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "rail",
    [
      { label: "left", query: { tabs: "left" } },
      { label: "right", query: { tabs: "right" } },
    ],
    async (variant, violations, notes) => {
      const label = `rail ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        // The panel on the far side, so no tile is joined.
        {
          ...variant.query,
          collapsed: 1,
          wco: "none",
          dock: "right",
          surface: "epic",
          sidebar: variant.query.tabs === "left" ? "right" : "left",
        },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);
      await evaluate(
        client,
        `window.__layoutCanvasProbe.setIndicators(${JSON.stringify(RAIL_INDICATORS)}, {})`,
      );
      await settle(client, 1400);
      await checkRailTiles(client, fail, say);
      await saveShot(client, `rail-${variant.label}`);
      await evaluate(client, "window.__layoutCanvasProbe.setCollapsed(false)");
      await settle(client, 400);
      await checkPulseUnclipped(client, variant, fail, say);
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "a 60px rail on both edges, each tile's badge by kind in a 14px disc at the top-right, and the waiting pulse painted past the last row at the list's scrolled edge",
  );
}

const RAIL_TILES_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const tiles = [...strip.querySelectorAll('[data-side-tab="collapsed"][data-tile-kind="monogram"]')];
  return {
    strip: box(strip),
    tiles: Object.fromEntries(tiles.map((tile) => {
      const badge = tile.querySelector('[data-testid="side-tab-rail-badge"]');
      return [(tile.querySelector('[data-testid="side-tab-monogram-chip"]')?.textContent ?? "").trim(), {
        rect: box(tile),
        badge: badge === null ? null : { kind: badge.getAttribute("data-kind"), rect: box(badge), radius: getComputedStyle(badge).borderTopLeftRadius },
      }];
    })),
  };
})()`;

async function checkRailTiles(client, fail, say) {
  const probe = await evaluate(client, RAIL_TILES_PROBE);
  if (Math.abs(probe.strip.width - SIDE_STRIP_RAIL_WIDTH) > 0.5)
    fail(
      `the rail is ${probe.strip.width.toFixed(1)}px wide, not ${String(SIDE_STRIP_RAIL_WIDTH)}`,
    );
  for (const [monogram, badge] of Object.entries(RAIL_EXPECTED)) {
    const tile = probe.tiles[monogram];
    if (tile === undefined) {
      fail(
        `no ${monogram} tile in the rail (tiles: ${Object.keys(probe.tiles).join(", ")})`,
      );
      continue;
    }
    const kind = tile.badge?.kind ?? null;
    if (kind !== badge)
      fail(`${monogram}: badge ${String(kind)}, expected ${String(badge)}`);
    if (tile.badge !== null) {
      const b = tile.badge.rect;
      if (
        Math.abs(b.width - SIDE_TAB_RAIL_BADGE) > 0.5 ||
        Math.abs(b.height - SIDE_TAB_RAIL_BADGE) > 0.5
      )
        fail(
          `${monogram}: the badge is ${boxText(b)}, not a ${String(SIDE_TAB_RAIL_BADGE)}px disc`,
        );
      if (Number.parseFloat(tile.badge.radius) < SIDE_TAB_RAIL_BADGE / 2)
        fail(
          `${monogram}: the badge's radius is ${tile.badge.radius}, so it is not a disc`,
        );
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const t = tile.rect;
      if (cx < t.x + t.width / 2 || cy > t.y + t.height / 2)
        fail(
          `${monogram}: the badge ${boxText(b)} is not at the tile's top-right ${boxText(t)}`,
        );
    }
  }
  say(
    Object.entries(probe.tiles)
      .map(
        ([monogram, tile]) =>
          `${monogram}${tile.badge === null ? "" : ` ${tile.badge.kind}`}`,
      )
      .join("; "),
  );
}

/**
 * The pulse's ring reaches 8px past its row; at the list's bottom edge, with
 * the list scrolled to its end, the list's own padding has to hold it.
 */
async function checkPulseUnclipped(client, variant, fail, say) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 420,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    await evaluate(
      client,
      `window.__layoutCanvasProbe.setIndicators(${JSON.stringify(RAIL_INDICATORS)}, {})`,
    );
    await evaluate(
      client,
      `(() => { const list = document.querySelector('[data-testid="side-tab-strip"] [data-strip-axis="y"]'); list.scrollTop = list.scrollHeight; })()`,
    );
    await settle(client, 400);
    const zeta = await rowRect(client, "epic:fixture-zeta");
    const list = await rectOf(
      client,
      '[data-testid="side-tab-strip"] [data-strip-axis="y"]',
    );
    const spot = { x: zeta.cx, y: zeta.y + zeta.height + 2 };
    const quiet = await samplePixelAt(client, spot.x, spot.y);
    await evaluate(
      client,
      `window.__layoutCanvasProbe.setIndicators(${JSON.stringify({ ...RAIL_INDICATORS, "fixture-zeta": { ...NO_INDICATOR, pendingApproval: true } })}, {})`,
    );
    // Held a third into its first ring: the spread is past 2px and the colour still shows.
    const held = await evaluate(
      client,
      `(() => {
      const row = document.querySelector('[data-testid="tab-close-epic-fixture-zeta"]').closest("[data-side-tab]");
      const rings = row.getAnimations().filter((animation) => animation.animationName === "side-strip-waiting-pulse");
      for (const ring of rings) { ring.pause(); ring.currentTime = 200; }
      return rings.length;
    })()`,
    );
    await flush(client);
    const pulsing = await samplePixelAt(client, spot.x, spot.y);
    await saveShot(client, `pulse-${variant.label}`);
    await evaluate(
      client,
      `document.querySelector('[data-testid="tab-close-epic-fixture-zeta"]').closest("[data-side-tab]").getAnimations().forEach((animation) => animation.finish())`,
    );
    if (held === 0) {
      fail("Zeta going into waiting started no pulse");
      return;
    }
    const room = list.y + list.height - (zeta.y + zeta.height);
    if (room < WAITING_PULSE_SPREAD - 0.5)
      fail(
        `the last row ends ${room.toFixed(1)}px above the list's clip, less than the pulse's ${String(WAITING_PULSE_SPREAD)}px spread`,
      );
    if (sameRgb(quiet, pulsing, 6))
      fail(
        `the pulse is not painted 2px below the last row (${rgbText(pulsing)}, quiet ${rgbText(quiet)}): the list clips it`,
      );
    say(
      `pulse below the last row: ${rgbText(quiet)} -> ${rgbText(pulsing)}, ${room.toFixed(1)}px to the list's clip`,
    );
  } finally {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1500,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle(client, 300);
  }
}

// --- the strip's top block (F1, F7): the order, the rail's axis and rhythm, New Task ---

const STRIP_TOP_VARIANTS = ["left", "right"].flatMap((tabs) =>
  ["none", "mac"].flatMap((wco) =>
    [1, 0].map((collapsed) => ({
      label: `${tabs}, ${wco === "mac" ? "macOS" : "browser"}, ${collapsed === 1 ? "rail" : "expanded"}`,
      shot: `top-${tabs}-${wco}-${collapsed === 1 ? "rail" : "expanded"}`,
      // The panel on the strip's side, so the active tile joins it (D3).
      query: { tabs, wco, collapsed, sidebar: tabs },
    })),
  ),
);

/** The collapsed nav tiles (expand, Notifications, All tasks, New Task, the avatar): 32px squares. */
const STRIP_NAV_TILE = 32;

const STRIP_TOP_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const q = (selector) => strip.querySelector(selector);
  const primary = document.createElement("span");
  primary.style.background = "var(--primary)";
  document.body.append(primary);
  const primaryFill = getComputedStyle(primary).backgroundColor;
  primary.remove();
  const newTask = q('[data-testid="side-strip-new-task"]');
  const homeRow = q('[data-testid="tab-home"]');
  const tiles = [...strip.querySelectorAll('[data-testid="header-tab-strip-scroll"] [data-side-tab="collapsed"]')].map((tile) => ({
    text: (tile.querySelector('[data-testid="side-tab-monogram-chip"]')?.textContent ?? "").trim(),
    joined: tile.hasAttribute("data-side-tab-joined"),
    rect: box(tile),
    chip: box(tile.querySelector('[data-testid="side-tab-monogram-chip"]')),
    meter: box(tile.querySelector('[data-testid="side-tab-meter"]')),
    badge: box(tile.querySelector('[data-testid="side-tab-rail-badge"]')),
  }));
  return {
    strip: box(strip),
    titleRow: box(q('[data-testid="side-strip-title-row"]')),
    toggle: box(q('[data-testid="side-tab-strip-collapse"]')),
    inbox: box(q('[data-testid="side-strip-inbox"]')),
    allTasks: box(q('[data-testid="side-strip-all-tasks"]')),
    newTask: box(newTask),
    newTaskFill: newTask === null ? null : getComputedStyle(newTask).backgroundColor,
    newTaskIcon: box(newTask?.querySelector("svg") ?? null),
    newTaskLabel: box(q('[data-testid="side-strip-new-task-label"]')),
    primaryFill,
    divider: box(q('[data-testid="side-strip-rail-divider"]')),
    home: box(homeRow),
    homeIcon: box(homeRow?.querySelector("svg") ?? null),
    homeTitle: box(homeRow?.querySelector('[data-testid="side-tab-title"]') ?? null),
    tasksLabel: box(q('[data-testid="side-strip-tasks-label"]')),
    // The list's own items - a tile, a split pair, a group header - as the
    // rhythm's units: a pair's members are spaced by its seam, not the gap.
    items: [...(q('[data-testid="header-tab-strip-scroll"]')?.children ?? [])]
      .map((node) => box(node))
      .filter((rect) => rect.height > 0),
    inboxIcon: box(q('[data-testid="side-strip-inbox"] svg')),
    inboxMark: box(q('[data-testid="side-strip-inbox-needs-you-badge"]') ?? q('[data-testid="side-strip-inbox-unknown-indicator"]')),
    rows: [...strip.querySelectorAll('[data-side-tab="expanded"]')].map((row) => {
      const tile = row.querySelector('[data-testid="side-tab-leading-tile"]');
      const letters = tile?.querySelector("span[aria-hidden]")?.firstChild ?? null;
      let text = null;
      if (letters !== null && letters.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.selectNodeContents(letters);
        text = box(range);
      }
      return {
        title: (row.querySelector('[data-testid="side-tab-title"]')?.textContent ?? "").trim(),
        titleRect: box(row.querySelector('[data-testid="side-tab-title"]')),
        meter: box(row.querySelector('[data-testid="side-tab-meter"]')),
        tile: box(tile),
        text,
      };
    }),
    avatar: box(q('[data-testid="user-menu-trigger"]')),
    tiles,
  };
})()`;

async function runStripTopPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "striptop",
    STRIP_TOP_VARIANTS,
    async (variant, violations, notes) => {
      const label = `striptop ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        { ...variant.query, dock: "right", surface: "epic", account: 1 },
        label,
      );
      await evaluate(
        client,
        `window.__layoutCanvasProbe.setIndicators(${JSON.stringify(RAIL_INDICATORS)}, {})`,
      );
      await evaluate(
        client,
        `window.__layoutCanvasProbe.setActivity(${JSON.stringify(RAIL_ACTIVITY)})`,
      );
      for (const theme of ["light", "dark"]) {
        await evaluate(
          client,
          `window.__layoutCanvasProbe.setTheme(${JSON.stringify(theme)})`,
        );
        await settle(client, 600);
        const fail = (line) => violations.push(`${label}, ${theme}: ${line}`);
        const probe = await evaluate(client, STRIP_TOP_PROBE);
        // Geometry once; what a theme can change - the fill and the
        // divider's contrast - in both.
        if (theme === "light") {
          if (variant.query.collapsed === 1)
            checkRailColumn(probe, variant, fail);
          else checkExpandedTop(probe, fail);
        }
        if (variant.query.collapsed === 1)
          await checkRailDividerDrawn(client, probe.divider, fail);
        checkNewTaskPrimary(probe, fail);
        await saveStripShot(client, probe.strip, `${variant.shot}-${theme}`);
        if (theme === "dark")
          notes.push(`${label}: ${describeStripTop(probe)}`);
      }
      await evaluate(client, 'window.__layoutCanvasProbe.setTheme("system")');
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    `${String(STRIP_TOP_VARIANTS.length)} windows - the rail as one centred column (expand, Notifications, All tasks, New Task, a divider, Home, the tiles, the avatar) with an even rhythm, and the expanded New Task as a primary-filled row after Home, aligned with it; the fill and the divider in both themes`,
  );
}

/** The strip and 48px of what it joins, at 2x, so a shot shows the rail's detail. */
async function saveStripShot(client, strip, name) {
  if (SHOTS_DIR === null) return;
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: {
      x: Math.max(0, strip.x - 48),
      y: strip.y,
      width: strip.width + 96,
      height: strip.height,
      scale: 2,
    },
  });
  await mkdir(SHOTS_DIR, { recursive: true });
  await writeFile(
    path.join(SHOTS_DIR, `${name}.png`),
    Buffer.from(shot.data, "base64"),
  );
}

function describeStripTop(probe) {
  const y = (name, rect) =>
    rect === null ? `${name} -` : `${name} ${rect.y.toFixed(0)}`;
  return [
    y("toggle", probe.toggle),
    y("inbox", probe.inbox),
    y("all", probe.allTasks),
    y("new", probe.newTask),
    y("divider", probe.divider),
    y("home", probe.home),
    `tiles ${probe.tiles.map((tile) => tile.rect.y.toFixed(0)).join("/")}`,
    y("avatar", probe.avatar),
  ].join(", ");
}

function checkNewTaskPrimary(probe, fail) {
  if (probe.newTask === null) {
    fail("no New Task button (side-strip-new-task)");
    return;
  }
  if (probe.newTaskFill !== probe.primaryFill)
    fail(
      `New Task fills ${String(probe.newTaskFill)}, not the primary ${probe.primaryFill} (F7)`,
    );
}

/**
 * F1: one column, top to bottom - the title row (macOS left), expand, Notifications,
 * All tasks, New Task, the divider, Home, the tiles, the avatar - every part
 * centred on the rail's axis, the nav tiles 4px apart, the divider midway
 * between New Task and Home, and Home spaced from the first tile as the tiles
 * are from each other.
 */
function checkRailColumn(probe, variant, fail) {
  const ownsTitleBar =
    variant.query.tabs === "left" && variant.query.wco === "mac";
  const column = [
    ...(ownsTitleBar ? [["title row", probe.titleRow]] : []),
    ["expand", probe.toggle],
    ["inbox", probe.inbox],
    ["all tasks", probe.allTasks],
    ["new task", probe.newTask],
    ["divider", probe.divider],
    ["home", probe.home],
    ...probe.tiles.map((tile) => [`tile ${tile.text}`, tile.rect]),
    ["avatar", probe.avatar],
  ];
  for (const [name, rect] of column)
    if (rect === null) fail(`no ${name} in the rail`);
  const present = column.filter(([, rect]) => rect !== null);
  for (let index = 1; index < present.length; index += 1) {
    const [aboveName, above] = present[index - 1];
    const [name, rect] = present[index];
    if (rect.y < above.y + above.height - 0.5)
      fail(
        `${name} (top ${rect.y.toFixed(1)}) is not below ${aboveName} (bottom ${(above.y + above.height).toFixed(1)})`,
      );
  }
  const axis = probe.strip.x + probe.strip.width / 2;
  const centred = [
    ["expand", probe.toggle],
    ["inbox", probe.inbox],
    ["all tasks", probe.allTasks],
    ["new task", probe.newTask],
    ["divider", probe.divider],
    ["home", probe.home],
    ["avatar", probe.avatar],
    ...probe.tiles.flatMap((tile) => [
      [`${tile.text} chip`, tile.chip],
      [`${tile.text} meter`, tile.meter],
    ]),
  ];
  for (const [name, rect] of centred) {
    if (rect === null) continue;
    const centre = rect.x + rect.width / 2;
    if (Math.abs(centre - axis) > 0.5)
      fail(
        `${name} is centred at x=${centre.toFixed(1)}, off the rail's axis x=${axis.toFixed(1)}`,
      );
  }
  for (const [name, rect] of [
    ["expand", probe.toggle],
    ["inbox", probe.inbox],
    ["all tasks", probe.allTasks],
    ["new task", probe.newTask],
    ["avatar", probe.avatar],
  ]) {
    if (rect === null) continue;
    if (
      Math.abs(rect.width - STRIP_NAV_TILE) > 0.5 ||
      Math.abs(rect.height - STRIP_NAV_TILE) > 0.5
    )
      fail(
        `${name} is ${boxText(rect)}, not a ${String(STRIP_NAV_TILE)}px tile`,
      );
  }
  // The Notifications tile's mark sits on its glyph's top-right corner as a task
  // badge sits on its chip: centred 1px out from that corner. Alpha waits on
  // an approval (RAIL_INDICATORS), so there is always a mark to place.
  if (probe.inboxIcon === null || probe.inboxMark === null)
    fail("the Notifications tile draws no glyph or no mark while a task waits");
  else {
    const cx = probe.inboxMark.x + probe.inboxMark.width / 2;
    const expectedX = probe.inboxIcon.x + probe.inboxIcon.width + 1;
    const cy = probe.inboxMark.y + probe.inboxMark.height / 2;
    const expectedY = probe.inboxIcon.y - 1;
    if (Math.abs(cx - expectedX) > 0.75 || Math.abs(cy - expectedY) > 0.75)
      fail(
        `the Notifications mark ${boxText(probe.inboxMark)} is centred at (${cx.toFixed(1)}, ${cy.toFixed(1)}), not on the glyph's corner (${expectedX.toFixed(1)}, ${expectedY.toFixed(1)})`,
      );
  }
  const gap = (above, below) =>
    above === null || below === null
      ? null
      : below.y - (above.y + above.height);
  const navGaps = [
    gap(probe.toggle, probe.inbox),
    gap(probe.inbox, probe.allTasks),
    gap(probe.allTasks, probe.newTask),
  ].filter((value) => value !== null);
  if (navGaps.some((value) => Math.abs(value - navGaps[0]) > 0.5))
    fail(
      `the nav tiles are ${navGaps.map((value) => value.toFixed(1)).join("/")}px apart, not evenly`,
    );
  const aboveDivider = gap(probe.newTask, probe.divider);
  const belowDivider = gap(probe.divider, probe.home);
  if (
    aboveDivider !== null &&
    belowDivider !== null &&
    Math.abs(aboveDivider - belowDivider) > 0.5
  )
    fail(
      `the divider is ${aboveDivider.toFixed(1)}px below New Task and ${belowDivider.toFixed(1)}px above Home, not midway`,
    );
  const rhythm = [probe.home, ...probe.items].filter((rect) => rect !== null);
  const itemGaps = rhythm
    .slice(1)
    .map((rect, index) => gap(rhythm[index], rect));
  if (itemGaps.some((value) => Math.abs(value - itemGaps[0]) > 0.5))
    fail(
      `Home and the list's items are ${itemGaps.map((value) => value.toFixed(1)).join("/")}px apart, not evenly`,
    );
  for (const tile of probe.tiles) {
    if (tile.badge === null || tile.chip === null) continue;
    const t = tile.joined
      ? { ...tile.rect, x: tile.chip.x + tile.chip.width / 2 - 20, width: 40 }
      : tile.rect;
    if (
      tile.badge.x + tile.badge.width > t.x + t.width + 0.5 ||
      tile.badge.y < t.y - 1.5
    )
      fail(
        `the ${tile.text} badge ${boxText(tile.badge)} spills past its tile ${boxText(t)}`,
      );
  }
}

/** The divider's line against the ground 4px above it: a hairline that reads, in both themes. */
async function checkRailDividerDrawn(client, divider, fail) {
  if (divider === null) return;
  const x = Math.round(divider.x + divider.width / 2);
  const y = Math.round(divider.y);
  const pixels = await regionPixels(client, x, y - 4, 1, 5);
  const ground = pixels.slice(0, 3);
  const line = pixels.slice(12, 15);
  const ratio = contrastRatio(ground, line);
  if (ratio < RAIL_DIVIDER_CONTRAST_FLOOR)
    fail(
      `the divider ${rgbText(line)} on the ground ${rgbText(ground)} is ${ratio.toFixed(2)}:1, under ${String(RAIL_DIVIDER_CONTRAST_FLOOR)}:1, so it does not read`,
    );
}

/** Two monogram letters keep at least this much of their tile on each side. */
const MONOGRAM_SIDE_CLEARANCE = 2.5;

/** A hairline has to stand off the ground by at least this much to be seen. */
const RAIL_DIVIDER_CONTRAST_FLOOR = 1.15;

/** F7 expanded: Notifications, All tasks, Home, then New Task, level with Home's icon and title. */
function checkExpandedTop(probe, fail) {
  const column = [
    ["inbox", probe.inbox],
    ["all tasks", probe.allTasks],
    ["home", probe.home],
    ["new task", probe.newTask],
    ["tasks label", probe.tasksLabel],
  ];
  for (const [name, rect] of column)
    if (rect === null) fail(`no ${name} in the top block`);
  const present = column.filter(([, rect]) => rect !== null);
  for (let index = 1; index < present.length; index += 1) {
    const [aboveName, above] = present[index - 1];
    const [name, rect] = present[index];
    if (rect.y < above.y + above.height - 0.5)
      fail(`${name} is not below ${aboveName}`);
  }
  if (probe.newTask === null || probe.home === null) return;
  if (
    Math.abs(probe.newTask.x - probe.home.x) > 0.5 ||
    Math.abs(probe.newTask.width - probe.home.width) > 0.5 ||
    Math.abs(probe.newTask.height - probe.home.height) > 0.5
  )
    fail(
      `New Task ${boxText(probe.newTask)} is not the Home row's box ${boxText(probe.home)}`,
    );
  if (
    probe.newTaskIcon !== null &&
    probe.homeIcon !== null &&
    Math.abs(probe.newTaskIcon.x - probe.homeIcon.x) > 0.5
  )
    fail(
      `New Task's icon is at x=${probe.newTaskIcon.x.toFixed(1)}, Home's at x=${probe.homeIcon.x.toFixed(1)}`,
    );
  if (
    probe.newTaskLabel !== null &&
    probe.homeTitle !== null &&
    Math.abs(probe.newTaskLabel.x - probe.homeTitle.x) > 0.5
  )
    fail(
      `New Task's label is at x=${probe.newTaskLabel.x.toFixed(1)}, Home's title at x=${probe.homeTitle.x.toFixed(1)}`,
    );
  const middle = (rect) => rect.y + rect.height / 2;
  for (const row of probe.rows) {
    if (row.meter !== null && row.titleRect !== null) {
      if (Math.abs(middle(row.meter) - middle(row.titleRect)) > 0.5)
        fail(
          `"${row.title}": the meter is centred at y=${middle(row.meter).toFixed(1)}, the title at y=${middle(row.titleRect).toFixed(1)}`,
        );
    }
    if (row.tile !== null && row.text !== null) {
      const left = row.text.x - row.tile.x;
      const right = row.tile.x + row.tile.width - (row.text.x + row.text.width);
      if (left < MONOGRAM_SIDE_CLEARANCE || right < MONOGRAM_SIDE_CLEARANCE)
        fail(
          `"${row.title}": the monogram's letters stand ${left.toFixed(1)}px/${right.toFixed(1)}px from its tile's edges, under ${String(MONOGRAM_SIDE_CLEARANCE)}px`,
        );
    }
  }
}

// --- F9: a handle drag across the snap point switches the layout live ---

const SIDE_STRIP_PERSIST_KEY = "traycer-gui-app:side-tab-strip";

const STRIP_RESIZE_PROBE = `(() => {
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const handle = strip.querySelector('[data-testid="side-tab-strip-resize-handle"]');
  const r = strip.getBoundingClientRect();
  const h = handle.getBoundingClientRect();
  const joined = strip.querySelector("[data-sheet-joined]");
  let persisted = null;
  try {
    persisted = JSON.parse(localStorage.getItem(${JSON.stringify(SIDE_STRIP_PERSIST_KEY)}) ?? "null")?.state ?? null;
  } catch {
    persisted = null;
  }
  return {
    width: r.width,
    handle: { x: h.x + h.width / 2, y: h.y + h.height / 2 },
    collapsed: strip.getAttribute("data-collapsed"),
    tiles: strip.querySelectorAll('[data-side-tab="collapsed"]').length,
    rows: strip.querySelectorAll('[data-side-tab="expanded"]').length,
    divider: strip.querySelector('[data-testid="side-strip-rail-divider"]') !== null,
    newTaskLabel: strip.querySelector('[data-testid="side-strip-new-task-label"]') !== null,
    liveAgents: strip.querySelectorAll('[data-testid="side-strip-live-agents-slot"] [data-testid^="strip-live-agent-fixture-agent-"]').length,
    joined: joined === null ? null : joined.getAttribute("data-side-tab"),
    persisted,
  };
})()`;

/**
 * F9: the strip's layout follows a real handle drag across the snap point at
 * the crossing, both ways and on both edges, with the pointer still down, and
 * the store is written once, on release. The crossing's own rules (out of the
 * rail, a cancelled drag, the stored width) are `side-tab-strip.test.tsx`'s;
 * what only a browser has is the handle jumping under a held, captured
 * pointer, and the eased width (`checkStripCrossingEase`).
 */
async function runStripResizePhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "stripresize",
    [
      { label: "left", edge: "left", sidebar: "left" },
      { label: "right", edge: "right", sidebar: "right" },
    ],
    async (variant, violations, notes) => {
      const label = `stripresize ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          tabs: variant.edge,
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "epic",
          sidebar: variant.sidebar,
          view: "activity",
        },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);
      await evaluate(
        client,
        `window.__layoutCanvasProbe.setActivity(${JSON.stringify(RAIL_ACTIVITY)})`,
      );
      await settle(client, 500);
      // Toward the content grows the strip: right on a left strip.
      const sign = variant.edge === "left" ? 1 : -1;
      const probe = () => evaluate(client, STRIP_RESIZE_PROBE);
      const expectLayout = (state, want, where) => {
        const collapsed = want === "rail";
        if (state.collapsed !== String(collapsed))
          fail(
            `${where}: data-collapsed=${String(state.collapsed)}, expected ${String(collapsed)}`,
          );
        if (
          collapsed
            ? state.tiles === 0 || state.rows > 0
            : state.rows === 0 || state.tiles > 0
        )
          fail(
            `${where}: ${String(state.tiles)} tiles and ${String(state.rows)} rows, expected the ${want} layout`,
          );
        if (state.divider !== collapsed)
          fail(
            `${where}: the rail divider is ${state.divider ? "drawn" : "absent"}, expected the ${want} top block`,
          );
        if (state.newTaskLabel === collapsed)
          fail(
            `${where}: the New Task label is ${state.newTaskLabel ? "drawn" : "absent"}, expected the ${want} top block`,
          );
        if (state.liveAgents > 0 === collapsed)
          fail(
            `${where}: ${String(state.liveAgents)} live agents under the active row, expected ${collapsed ? "none on the rail" : "Epsilon's 3"}`,
          );
        if (state.joined !== (collapsed ? "collapsed" : "expanded"))
          fail(
            `${where}: the joined item is ${String(state.joined)}, expected the ${want}'s`,
          );
      };
      const expectWidth = (state, width, where) => {
        if (Math.abs(state.width - width) > 1.5)
          fail(
            `${where}: the strip is ${state.width.toFixed(1)}px wide, expected ${String(width)}`,
          );
      };
      const expectPersisted = (state, collapsed, where) => {
        if (state.persisted?.collapsed !== collapsed)
          fail(
            `${where}: the stored collapsed flag is ${String(state.persisted?.collapsed)}, expected ${String(collapsed)}`,
          );
      };

      let state = await probe();
      const startWidth = state.width;
      const grip = state.handle;
      const at = (width) => ({
        x: grip.x + sign * (width - startWidth),
        y: grip.y,
      });
      const shotName = `stripresize-${variant.edge}-sidebar-${variant.sidebar}`;
      await checkStripCrossingEase(client, {
        grip,
        at,
        startWidth,
        shotName,
        fail,
        say,
      });

      // 1. Expanded -> under the snap point, pointer held: the rail's layout.
      await pressAt(client, grip.x, grip.y);
      await moveInSteps(client, grip, at(100));
      await settle(client, 150);
      state = await probe();
      await saveShot(client, `${shotName}-1-held-under-snap`);
      // Snapped live to the rail (ruling): never a rail drawn in a wider strip.
      expectWidth(state, SIDE_STRIP_RAIL_WIDTH, "held under the snap point");
      expectLayout(state, "rail", "held under the snap point");
      expectPersisted(
        state,
        false,
        "held under the snap point (nothing stored mid-drag)",
      );
      // 2. Back over it, still held: the expanded layout again.
      await moveInSteps(client, at(100), at(220));
      await settle(client, 150);
      state = await probe();
      await saveShot(client, `${shotName}-2-held-over-snap`);
      expectWidth(state, 220, "held back over the snap point");
      expectLayout(state, "expanded", "held back over the snap point");
      // 3. Under again and released: the rail, stored once.
      await moveInSteps(client, at(220), at(100));
      await releaseAt(client, at(100).x, at(100).y);
      await settle(client, 300);
      state = await probe();
      expectWidth(
        state,
        SIDE_STRIP_RAIL_WIDTH,
        "released under the snap point",
      );
      expectLayout(state, "rail", "released under the snap point");
      expectPersisted(state, true, "released under the snap point");

      say(
        `final ${state.width.toFixed(0)}px, stored ${JSON.stringify(state.persisted)}`,
      );

      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "on both edges a real handle drag switches the strip between the rail and the expanded layout at the snap point with the pointer still down (tiles, top block, joined item, the Activity view's live agents), and stores the result once on release; the crossing eases, and Escape and a release land at once",
  );
}

/** A slowed panel motion token, so a probe and a screenshot land inside the ease. */
const SLOW_PANEL_MOTION_MS = 1500;

async function setPanelMotionMs(client, ms) {
  await evaluate(
    client,
    ms === null
      ? `document.documentElement.style.removeProperty("--panel-animation-duration")`
      : `document.documentElement.style.setProperty("--panel-animation-duration", "${String(ms)}ms")`,
  );
}

/**
 * L-165: the drag frame that crosses the snap point eases the jump between
 * the minimum and the rail with the panel motion token, the joined tile's
 * bridge staying on the strip's content-facing edge while it runs; Escape and
 * a release land at once, and under reduced motion the crossing does too.
 * Leaves the strip expanded at `startWidth`.
 */
async function checkStripCrossingEase(client, input) {
  const { grip, at, startWidth, shotName, fail, say } = input;
  const width = () =>
    evaluate(client, STRIP_RESIZE_PROBE).then((state) => state.width);
  await setPanelMotionMs(client, SLOW_PANEL_MOTION_MS);
  try {
    // A third into the ease: between the minimum and the rail, joins attached.
    await pressAt(client, grip.x, grip.y);
    await moveInSteps(client, grip, at(100));
    await settle(client, SLOW_PANEL_MOTION_MS / 3);
    const mid = await evaluate(client, STRIP_RESIZE_PROBE);
    const join = await evaluate(client, JOIN_PROBE);
    await saveShot(client, `${shotName}-0-mid-ease`);
    if (!(mid.width > SIDE_STRIP_RAIL_WIDTH + 4 && mid.width < 188))
      fail(
        `mid-crossing: the strip is ${mid.width.toFixed(1)}px wide, expected an eased width between the rail and the minimum`,
      );
    if (mid.collapsed !== "true")
      fail(
        `mid-crossing: data-collapsed=${String(mid.collapsed)}, expected the rail's layout at once`,
      );
    if (join.joined === null || join.bridge === null) {
      fail("mid-crossing: no joined tile or no bridge while the width eases");
    } else {
      // As at rest: the bridge runs from the tile's content-facing edge to
      // just past the strip's, so it tracks both while the width eases.
      const strip = join.strip;
      const tile = join.joined.rect;
      const onLeft = join.joined.edge === "left";
      const tileEdge = onLeft ? tile.x + tile.width : tile.x;
      const stripEdge = onLeft ? strip.x + strip.width : strip.x;
      const [bridgeInner, bridgeOuter] = onLeft
        ? [join.bridge.x, join.bridge.x + join.bridge.width]
        : [join.bridge.x + join.bridge.width, join.bridge.x];
      if (Math.abs(join.bridge.y - tile.y) > 0.5)
        fail(
          `mid-crossing: the bridge ${boxText(join.bridge)} is not level with its tile ${boxText(tile)}`,
        );
      if (Math.abs(bridgeInner - tileEdge) > 1.5)
        fail(
          `mid-crossing: the bridge starts at x=${bridgeInner.toFixed(1)}, off the tile's edge at x=${tileEdge.toFixed(1)}`,
        );
      if (Math.abs(bridgeOuter - stripEdge) > 2)
        fail(
          `mid-crossing: the bridge ends at x=${bridgeOuter.toFixed(1)}, off the strip's content edge at x=${stripEdge.toFixed(1)}`,
        );
    }
    // Escape mid-ease: the starting width at once.
    await pressKey(client, "Escape");
    const escaped = await width();
    if (Math.abs(escaped - startWidth) > 1.5)
      fail(
        `Escape mid-ease: ${escaped.toFixed(1)}px, expected ${startWidth.toFixed(1)} at once`,
      );
    await releaseAt(client, at(100).x, at(100).y);
    await settle(client, 100);
    // Released mid-ease: the rail at once.
    await pressAt(client, grip.x, grip.y);
    await moveInSteps(client, grip, at(100));
    await releaseAt(client, at(100).x, at(100).y);
    const released = await width();
    if (Math.abs(released - SIDE_STRIP_RAIL_WIDTH) > 1.5)
      fail(
        `release mid-ease: ${released.toFixed(1)}px, expected the rail's ${String(SIDE_STRIP_RAIL_WIDTH)} at once`,
      );
    say(
      `crossing eased (${mid.width.toFixed(0)}px a third in), Escape ${escaped.toFixed(0)}px and release ${released.toFixed(0)}px at once`,
    );
    await evaluate(client, "window.__layoutCanvasProbe.setCollapsed(false)");
    await settle(client, SLOW_PANEL_MOTION_MS + 200);
    // Reduced motion: the token goes to 0ms and the crossing lands at once.
    await emulateReducedMotion(client, "reduce");
    await pressAt(client, grip.x, grip.y);
    await moveInSteps(client, grip, at(100));
    const reduced = await width();
    await pressKey(client, "Escape");
    await releaseAt(client, at(100).x, at(100).y);
    if (Math.abs(reduced - SIDE_STRIP_RAIL_WIDTH) > 1.5)
      fail(
        `reduced motion: the crossing drew ${reduced.toFixed(1)}px, expected the rail at once`,
      );
  } finally {
    await emulateReducedMotion(client, "no-preference");
    await setPanelMotionMs(client, null);
  }
  await settle(client, 300);
}

// --- overlays: the hover card and the Notifications drawer, toward the content (the user menu is hostmenu's) ---

async function runOverlaysPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "overlays",
    [
      { label: "left", edge: "left" },
      { label: "right", edge: "right" },
    ],
    async (variant, violations, notes) => {
      const label = `overlays ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          tabs: variant.edge,
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "epic",
          sidebar: variant.edge,
          account: 1,
        },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);
      const strip = await rectOf(client, '[data-testid="side-tab-strip"]');
      const frame = await rectOf(client, SURFACE_FRAME);
      const viewport = await evaluate(
        client,
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      // Toward the content from what it is anchored to: the row, the account
      // row, or (for the drawer) the whole strip column.
      const placed = (name, box, anchor) => {
        if (box === null) {
          fail(`${name} did not open`);
          return;
        }
        const towardContent =
          variant.edge === "left"
            ? box.x >= anchor.x + anchor.width - 0.5
            : box.x + box.width <= anchor.x + 0.5;
        if (!towardContent)
          fail(
            `${name} ${boxText(box)} does not open toward the content from its anchor ${boxText(anchor)}`,
          );
        if (
          box.x < 0 ||
          box.y < 0 ||
          box.x + box.width > viewport.width ||
          box.y + box.height > viewport.height
        )
          fail(`${name} ${boxText(box)} leaves the window`);
        say(`${name} ${boxText(box)}`);
      };

      const alpha = await rowRect(client, "epic:fixture-alpha");
      await moveTo(client, alpha.cx, alpha.cy);
      await settle(client, 1200);
      placed(
        "the hover card",
        await rectOf(client, '[data-testid="side-tab-hover-card"]'),
        alpha,
      );
      await saveShot(client, `overlay-hover-${variant.edge}`);
      await moveTo(client, frame.cx, frame.cy);
      await settle(client, 400);

      const inbox = await rectOf(client, '[data-testid="side-strip-inbox"]');
      await pressAndRelease(client, inbox.cx, inbox.cy, "left");
      await settle(client, 600);
      const drawer = await rectOf(
        client,
        '[data-testid="side-strip-inbox-drawer"]',
      );
      placed("the Notifications drawer", drawer, strip);
      if (drawer !== null) {
        if (
          Math.abs(drawer.y - frame.y) > 1 ||
          Math.abs(drawer.y + drawer.height - (frame.y + frame.height)) > 1
        )
          fail(
            `the Notifications drawer ${boxText(drawer)} is not level with the sheets ${boxText(frame)}`,
          );
      }
      await saveShot(client, `overlay-inbox-${variant.edge}`);
      await pressKey(client, "Escape");
      await settle(client, 300);
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "on both edges the hover card and the Notifications drawer (flush with the frame) open toward the content and inside the window",
  );
}

// --- the strip foot's readings row (staging round 1, F6) ---

/** The readings row's `gap-2` (the rail's own 8px tile gap), and the foot's `gap-2` above the account row. */
const READINGS_GAP_PX = 8;
const FOOT_GAP_PX = 8;

const READINGS_PROBE = `(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  // A box drawn narrower than its content: the reading or any laid-out
  // descendant (an inline box has no clientWidth to compare). The reading's
  // own rectangle is not enough - a shrinkable wrapper can sit inside the
  // line while the text it holds runs past it (G6 review A).
  const overflows = (node) => [node, ...node.querySelectorAll('*')].some(
    (part) => part.clientWidth > 0 && getComputedStyle(part).display !== 'inline' && part.scrollWidth > part.clientWidth + 0.5,
  );
  // Each tile's readings: shown whole inside its one-row line, hidden on the
  // clipped wrap row or behind the tile's fallback, or cut (the mush this row
  // must avoid).
  const readings = (button, itemSelector) => {
    const tile = document.querySelector('[data-testid="side-strip-readings"] ' + button);
    if (tile === null) return null;
    return [...tile.querySelectorAll(itemSelector)].map((item) => {
      const line = item.parentElement.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      const inside = r.left >= line.left - 0.5 && r.right <= line.right + 0.5 && r.top >= line.top - 0.5 && r.bottom <= line.bottom + 0.5;
      const outside = r.top >= line.bottom - 0.5 || r.right <= line.left + 0.5 || r.left >= line.right - 0.5;
      const state = getComputedStyle(item).visibility === 'hidden' || outside ? "hidden" : inside && !overflows(item) ? "shown" : "cut";
      return { text: item.textContent.trim(), state };
    });
  };
  // A tile whose first reading cannot fit whole draws its fallback instead.
  const fallback = (button) => {
    const node = document.querySelector('[data-testid="side-strip-readings"] ' + button + ' [data-readings-fallback]');
    return node !== null && node.getClientRects().length > 0;
  };
  return {
    row: box('[data-testid="side-strip-readings"]'),
    usage: box('[data-testid="side-strip-readings"] [data-testid="rate-limit-header-button"]'),
    resource: box('[data-testid="side-strip-readings"] [data-testid="resource-monitor-header-button"]'),
    usageReadings: readings('[data-testid="rate-limit-header-button"]', '[data-testid^="status-bar-provider-segment-"]'),
    resourceReadings: readings('[data-testid="resource-monitor-header-button"]', '[data-testid^="status-bar-resource-metric-"]'),
    usageFallback: fallback('[data-testid="rate-limit-header-button"]'),
    resourceFallback: fallback('[data-testid="resource-monitor-header-button"]'),
    account: box('[data-testid="user-menu-trigger"]'),
    strip: box('[data-testid="side-tab-strip"]'),
  };
})()`;

async function runReadingsPhase(client, pageUrl, pageLoads) {
  const variants = [];
  for (const edge of ["left", "right"]) {
    for (const readings of ["both", "usage", "resource", "none"]) {
      variants.push({
        label: `${edge} ${readings}`,
        edge,
        readings,
        collapsed: 0,
      });
    }
    variants.push({
      label: `${edge} both collapsed`,
      edge,
      readings: "both",
      collapsed: 1,
    });
  }
  await runShellPhase(
    "readings",
    variants,
    async (variant, violations, notes) => {
      const label = `readings ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          tabs: variant.edge,
          collapsed: variant.collapsed,
          wco: "none",
          dock: "right",
          surface: "epic",
          sidebar: variant.edge,
          account: 1,
          hosts: 1,
          readings: variant.readings,
        },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);
      const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
      // The seeded readings land a tick after mount: the usage poll's two
      // fetches and the resource stream's first snapshot.
      await settle(client, 600);
      const m = await evaluate(client, READINGS_PROBE);
      const expected = {
        usage: variant.readings === "both" || variant.readings === "usage",
        resource:
          variant.readings === "both" || variant.readings === "resource",
      };
      for (const key of ["usage", "resource"]) {
        const drawn = m[key] !== null && m[key].width > 0;
        if (drawn !== expected[key])
          fail(
            `${key} is ${drawn ? "drawn" : "absent"}, expected ${expected[key] ? "drawn" : "absent"}`,
          );
      }
      if (variant.readings === "none") {
        if (m.row !== null && m.row.height > 0)
          fail(`the row takes ${boxText(m.row)} with no reading in it`);
      } else if (m.row === null || m.account === null) {
        fail("no readings row or no account row");
      } else if (variant.collapsed === 1) {
        // Collapsed: rail-wide tiles stacked, centred on the rail, above the avatar.
        const tiles = [m.usage, m.resource];
        for (const tile of tiles) {
          if (!near(tile.width, 40, 0.5))
            fail(`a tile is ${tile.width}px wide, expected 40`);
          if (!near(tile.cx, m.strip.cx, 1))
            fail(
              `a tile ${boxText(tile)} is off the rail's centre ${m.strip.cx}`,
            );
        }
        if (
          !near(m.resource.y, m.usage.y + m.usage.height + READINGS_GAP_PX, 0.5)
        )
          fail(
            `the tiles are not stacked ${READINGS_GAP_PX}px apart: ${boxText(m.usage)} / ${boxText(m.resource)}`,
          );
        if (m.resource.y + m.resource.height > m.account.y)
          fail("the tiles overlap the avatar tile");
        say(`tiles ${boxText(m.usage)} ${boxText(m.resource)}`);
      } else {
        // One row, flush with the account row's edges, directly above it.
        if (
          !near(m.row.x, m.account.x, 0.5) ||
          !near(m.row.width, m.account.width, 0.5)
        )
          fail(
            `the row ${boxText(m.row)} does not span the account row ${boxText(m.account)}`,
          );
        if (!near(m.account.y - (m.row.y + m.row.height), FOOT_GAP_PX, 0.5))
          fail(
            `the row is not ${FOOT_GAP_PX}px above the account row: ${boxText(m.row)} / ${boxText(m.account)}`,
          );
        const drawn = [m.usage, m.resource].filter(
          (b) => b !== null && b.width > 0,
        );
        if (drawn.length === 2) {
          const half = (m.row.width - READINGS_GAP_PX) / 2;
          for (const b of drawn) {
            if (!near(b.width, half, 0.5))
              fail(`a half is ${b.width}px, expected ${half}`);
            if (!near(b.y, m.row.y, 0.5) || !near(b.height, m.row.height, 0.5))
              fail(`${boxText(b)} is not on the row ${boxText(m.row)}`);
          }
          if (
            !near(m.usage.x, m.row.x, 0.5) ||
            !near(m.resource.x + m.resource.width, m.row.x + m.row.width, 0.5)
          )
            fail("usage is not first and resources last");
          say(
            `halves ${m.usage.width.toFixed(1)} + ${m.resource.width.toFixed(1)} of ${m.row.width.toFixed(1)}`,
          );
        } else if (drawn.length === 1) {
          if (!near(drawn[0].width, m.row.width, 0.5))
            fail(`the one reading is ${drawn[0].width}px of ${m.row.width}`);
          say(`full ${drawn[0].width.toFixed(1)} of ${m.row.width.toFixed(1)}`);
        }
      }
      // What each tile draws: whole readings only, the first always, and at
      // full width more than one - never a reading cut by the tile's edge,
      // never an icon alone in an empty box. Collapsed, the glyph alone.
      for (const [key, items, total, fellBack] of [
        ["usage", m.usageReadings, 2, m.usageFallback],
        ["resource", m.resourceReadings, 3, m.resourceFallback],
      ]) {
        if (!expected[key] || items === null) continue;
        if (variant.collapsed === 1) {
          if (items.length > 0)
            fail(
              `the collapsed ${key} tile draws readings ${JSON.stringify(items)}`,
            );
          continue;
        }
        if (items.length !== total)
          fail(
            `the ${key} tile holds ${items.length} readings, expected ${total}`,
          );
        const bad = items.filter((item) => item.state === "cut");
        if (bad.length > 0) fail(`the ${key} tile cuts ${JSON.stringify(bad)}`);
        const shown = items.filter((item) => item.state === "shown");
        const full = variant.readings !== "both";
        // The first reading whole, or - when not even that fits - the tile's
        // fallback with every reading in the popover. Never a cut one.
        const firstWhole = items.length > 0 && items[0].state === "shown";
        const fallbackOnly = fellBack && shown.length === 0;
        if (!firstWhole && !fallbackOnly)
          fail(
            `the ${key} tile shows neither its first reading nor its fallback: ${JSON.stringify(items)}`,
          );
        say(
          `${key} ${full ? "full" : "half"} shows ${fallbackOnly ? "its fallback" : shown.map((item) => JSON.stringify(item.text)).join(" ")}${shown.length < items.length ? ` (${items.length - shown.length} in the popover)` : ""}`,
        );
        // Usage draws the status bar's own readings, so how many fit is its
        // Style's to say (G6): the shipped Style spells the reset time out.
        // Under a compact one, half width shows the first reading (bar only)
        // and full width more than one (bar and percent).
        let fullShown = shown;
        if (key === "usage") {
          const compact = full ? "barPercent" : "barOnly";
          await evaluate(
            client,
            `window.__layoutCanvasProbe.applyUsageStyle(${JSON.stringify(compact)})`,
          );
          await settle(client, 300);
          const restyled = (await evaluate(client, READINGS_PROBE))
            .usageReadings;
          fullShown = restyled.filter((item) => item.state === "shown");
          if (restyled.some((item) => item.state === "cut"))
            fail(`the restyled usage tile cuts ${JSON.stringify(restyled)}`);
          if (restyled[0]?.state !== "shown")
            fail(
              `the restyled usage tile does not show its first reading: ${JSON.stringify(restyled)}`,
            );
          say(
            `usage ${full ? "full" : "half"}, ${compact}, shows ${fullShown.map((item) => JSON.stringify(item.text)).join(" ")}`,
          );
          await evaluate(client, "window.__layoutCanvasProbe.reset()");
          await settle(client, 300);
        }
        if (full && fullShown.length < 2)
          fail(
            `the full-width ${key} tile shows only ${fullShown.length} reading(s)`,
          );
      }
      // At rest, before any click leaves focus (and its tooltip) on a reading.
      await saveShot(
        client,
        `readings-${variant.edge}-${variant.readings}${variant.collapsed === 1 ? "-collapsed" : ""}`,
      );
      // Each reading's popover opens toward the content and inside the window.
      const viewport = await evaluate(
        client,
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      for (const [key, dialog] of [
        ["usage", "Usage limits"],
        ["resource", "Resources"],
      ]) {
        const anchor = m[key];
        if (anchor === null || anchor.width === 0) continue;
        await pressAndRelease(client, anchor.cx, anchor.cy, "left");
        await settle(client, 500);
        const box = await rectOf(
          client,
          `[role="dialog"][aria-label="${dialog}"]`,
        );
        if (box === null) {
          fail(`the ${key} popover did not open`);
        } else {
          const toward =
            variant.edge === "left"
              ? box.x >= anchor.x + anchor.width - 0.5
              : box.x + box.width <= anchor.x + 0.5;
          if (!toward)
            fail(
              `the ${key} popover ${boxText(box)} does not open toward the content`,
            );
          if (
            box.x < 0 ||
            box.y < 0 ||
            box.x + box.width > viewport.width ||
            box.y + box.height > viewport.height
          )
            fail(`the ${key} popover ${boxText(box)} leaves the window`);
          await saveShot(
            client,
            `readings-${variant.edge}-${variant.readings}-${variant.collapsed === 1 ? "collapsed-" : ""}${key}-popover`,
          );
        }
        await pressKey(client, "Escape");
        await settle(client, 300);
      }
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "on both edges: two readings split the row in half, one takes all of it, none draws no row; collapsed they stack as 40px tiles; each popover opens toward the content inside the window",
  );
}

// --- the account menu's Host section (staging round 1, F5; G4) ---

/**
 * What the Host section draws and where. Its rows, the inert offline host,
 * the check, the keyboard and a switch held in flight are
 * `user-menu-host-section.test.tsx`'s; what only a browser can say is the
 * menu's laid-out width and placement, and whether a name truncates.
 */
const HOST_MENU_PROBE = `(() => {
  const section = document.querySelector('[data-testid="user-menu-host-section"]');
  if (section === null) return null;
  return [...section.querySelectorAll('[data-testid^="user-menu-host-option-"]')].map((row) => ({
    hostId: row.getAttribute("data-testid").slice("user-menu-host-option-".length),
    truncated: (() => { const name = row.querySelector(".truncate"); return name !== null && name.scrollWidth > name.clientWidth + 0.5; })(),
    box: (() => { const r = row.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })(),
  }));
})()`;

async function runHostMenuPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "hostmenu",
    [
      { label: "left", query: { tabs: "left", sidebar: "left" } },
      { label: "right", query: { tabs: "right", sidebar: "right" } },
      { label: "top", query: { tabs: "top", sidebar: "left", header: "app" } },
    ],
    async (variant, violations, notes) => {
      const label = `hostmenu ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          ...variant.query,
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "epic",
          account: 1,
          hosts: 1,
        },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);
      // One real click, read 600ms later: a double toggle has closed it again.
      const trigger = await rectOf(client, '[data-testid="user-menu-trigger"]');
      await pressAndRelease(client, trigger.cx, trigger.cy, "left");
      await settle(client, 600);
      const rows = await evaluate(client, HOST_MENU_PROBE);
      if (rows === null) {
        fail("the menu has no Host section");
      } else {
        await saveShot(client, `hostmenu-${variant.label}`);
        // G4: a menu's width whatever a host is called, inside the window and
        // opening toward the content; the long names truncate and read in
        // full from their tooltips, and a name that fits has none.
        const geo = await evaluate(
          client,
          `(() => {
          const r = (s) => { const n = document.querySelector(s); if (n === null) return null; const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
          return { menu: r('[data-testid="user-menu-content"]'), trigger: r('[data-testid="user-menu-trigger"]'), vw: innerWidth, vh: innerHeight };
        })()`,
        );
        if (geo.menu.width > 256.5)
          fail(`the menu is ${geo.menu.width}px wide, over the 256px cap`);
        if (
          geo.menu.left < 0 ||
          geo.menu.top < 0 ||
          geo.menu.right > geo.vw ||
          geo.menu.bottom > geo.vh
        )
          fail(`the menu ${JSON.stringify(geo.menu)} leaves the window`);
        const toward =
          variant.label === "left"
            ? geo.menu.left >= geo.trigger.right - 0.5
            : variant.label === "right"
              ? geo.menu.right <= geo.trigger.left + 0.5
              : geo.menu.top >= geo.trigger.bottom - 0.5;
        if (!toward)
          fail(
            `the menu ${JSON.stringify(geo.menu)} does not open toward the content from ${JSON.stringify(geo.trigger)}`,
          );
        const tooltipText = async (row) => {
          await moveTo(client, row.box.x + 40, row.box.cy);
          await settle(client, 1200);
          return await evaluate(
            client,
            `document.querySelector('[role="tooltip"]')?.textContent ?? null`,
          );
        };
        // The long online name, the long offline one, and one that fits.
        for (const [hostId, fullName] of [
          [
            "fixture-host-builder",
            "build-vm-01.asia-south2-b.c.example-project.internal (staging)",
          ],
          [
            "fixture-host-mini",
            "gpu-runner-02.us-central1-a.c.example-project.internal (nightly)",
          ],
          ["fixture-host-studio", null],
        ]) {
          const row = rows.find((entry) => entry.hostId === hostId);
          if (row === undefined) {
            fail(`no ${hostId} row`);
            continue;
          }
          if (row.truncated !== (fullName !== null))
            fail(`${hostId}'s name is ${row.truncated ? "" : "not "}truncated`);
          const text = await tooltipText(row);
          if (fullName === null ? text !== null : !text?.includes(fullName))
            fail(`hovering ${hostId}'s name shows ${JSON.stringify(text)}`);
        }
        say(`${geo.menu.width.toFixed(0)}px menu`);
      }
      await pressKey(client, "Escape");
      await settle(client, 300);
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "the strip's and the header's account menu open on one click toward the content, inside the window and no wider than 256px, and a long host name, online or offline, truncates and reads in full from its tooltip while one that fits has none",
  );
}

// --- the Activity view (D9): the live agents under the active row, only while expanded ---

const LIVE_AGENTS_PROBE = `(() => {
  const slot = document.querySelector('[data-testid="side-strip-live-agents-slot"]');
  const rows = slot === null ? [] : [...slot.querySelectorAll('[data-testid^="strip-live-agent-fixture-agent-"]')];
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    slot: box(slot),
    rows: rows.map((row) => row.getAttribute("data-testid")),
    active: box(document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]')),
    strip: box(document.querySelector('[data-testid="side-tab-strip"]')),
    // Where each title's text starts: the task's, then each live agent's.
    titles: ["Epsilon cleanup", "Plan the migration", "Write the tests", "Rebuild the index"].map((text) => {
      const strip = document.querySelector('[data-testid="side-tab-strip"]');
      const walker = document.createTreeWalker(strip, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.data.trim() !== text) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().x;
      }
      return null;
    }),
  };
})()`;

async function runActivityPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "activity",
    [
      { label: "left", edge: "left" },
      { label: "right", edge: "right" },
    ],
    async (variant, violations, notes) => {
      const label = `activity ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          tabs: variant.edge,
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "epic",
          sidebar: variant.edge,
          view: "activity",
        },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      await evaluate(
        client,
        `window.__layoutCanvasProbe.setActivity(${JSON.stringify(RAIL_ACTIVITY)})`,
      );
      await settle(client, 500);
      const shown = await evaluate(client, LIVE_AGENTS_PROBE);
      await saveShot(client, `activity-${variant.edge}`);
      if (shown.rows.length !== 3)
        fail(
          `the strip lists ${String(shown.rows.length)} live agents, expected Epsilon's 3`,
        );
      // One 16px step (INDENT_PX) per level, the first from the task's title.
      const [task, plan, tests, index] = shown.titles;
      const steps = [
        ["Plan the migration", plan, task, 16],
        ["Write the tests", tests, task, 32],
        ["Rebuild the index", index, task, 16],
      ];
      for (const [name, x, from, step] of steps) {
        if (x === null || from === null)
          fail(`no title text for ${x === null ? name : "the task"}`);
        else if (Math.abs(x - from - step) > 0.5)
          fail(
            `${name}'s title starts ${(x - from).toFixed(1)}px past the task's title, expected ${String(step)}`,
          );
      }
      if (shown.slot === null || shown.active === null) {
        fail("no live-agents slot or no active row to measure");
      } else {
        if (shown.slot.y < shown.active.y + shown.active.height - 0.5)
          fail(
            `the live agents ${boxText(shown.slot)} are not under the active row ${boxText(shown.active)}`,
          );
        if (
          shown.slot.x < shown.strip.x ||
          shown.slot.x + shown.slot.width > shown.strip.x + shown.strip.width
        )
          fail(
            `the live agents ${boxText(shown.slot)} leave the strip ${boxText(shown.strip)}`,
          );
      }
      notes.push(
        `${label}: ${String(shown.rows.length)} under the active row at ${shown.slot === null ? "-" : boxText(shown.slot)}, titles at ${shown.titles.map((x) => (x === null ? "-" : x.toFixed(1))).join(" / ")}`,
      );
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "on both edges the active task's live agents sit under its row, inside the strip, each title indented one 16px step per level (when they show is live-agents-slot-store.test.ts's)",
  );
}

// --- the placement bar and the surface drag (D14, T09) ---

const PLACEMENT_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const bar = document.querySelector("[data-layout-placement-bar]");
  const aside = document.querySelector('aside[aria-label="Sample sidebar"]');
  const body = document.querySelector("[data-sample-workspace-body]");
  return {
    placement: document.querySelector("[data-tab-strip-placement]")?.getAttribute("data-tab-strip-placement") ?? null,
    stripEdge: document.querySelector('[data-testid="side-tab-strip"]')?.getAttribute("data-edge") ?? null,
    strip: box(document.querySelector('[data-testid="side-tab-strip"]')),
    spacer: box(document.querySelector('[data-testid="side-strip-drag-spacer"]')),
    ring: box(document.querySelector('[data-layout-selection-ring][data-on="1"]')),
    bar: bar === null ? null : {
      surface: bar.getAttribute("data-layout-placement-bar"),
      rect: box(bar),
      edges: [...bar.querySelectorAll("[data-placement-edge]")].map((node) => ({ edge: node.getAttribute("data-placement-edge"), checked: node.getAttribute("aria-checked"), rect: box(node) })),
      views: bar.querySelector('[role="radiogroup"][aria-label="Tabs view"]') !== null,
    },
    // The flat index's own "lit" row is gone with T3/T4: selecting a surface
    // now opens ITS AREA in the two-level form, so the dock's placement
    // control (Tab placement / Sidebar side) is what shows in its place.
    formArea: document.querySelector('[data-layout-inspector] [role="radiogroup"][aria-label="Tab placement"]') !== null
      ? "topBar"
      : document.querySelector('[data-layout-inspector] [role="radiogroup"][aria-label="Sidebar side"]') !== null
        ? "sidebar"
        : null,
    aside: box(aside),
    sidebarSide: aside === null || body === null ? null : (aside.getBoundingClientRect().x > body.getBoundingClientRect().x + body.getBoundingClientRect().width / 2 ? "right" : "left"),
    column: box(document.querySelector("[data-layout-column]")),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

async function runPlacementPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "placement",
    [{ label: "left" }],
    async (variant, violations, notes) => {
      const label = `placement ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          tabs: "left",
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "sample",
        },
        label,
      );
      await evaluate(client, "window.__layoutCanvasProbe.beginSession()");
      await settle(client, 600);
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);

      // The strip: selected by its own space, the bar beside it.
      let probe = await evaluate(client, PLACEMENT_PROBE);
      await pressAndRelease(client, probe.spacer.cx, probe.spacer.cy, "left");
      await settle(client, 600);
      probe = await evaluate(client, PLACEMENT_PROBE);
      await saveShot(client, "placement-strip-bar");
      checkBar(probe, "topBar", ["top", "left", "right"], "left", true, fail);
      if (
        probe.bar !== null &&
        probe.strip !== null &&
        probe.bar.rect.x < probe.strip.x + probe.strip.width
      )
        fail(
          `the bar ${boxText(probe.bar.rect)} covers the strip ${boxText(probe.strip)} it places`,
        );
      if (probe.formArea !== "topBar")
        fail(
          `selecting the tab strip did not open the Task tabs area in the dock (shows ${String(probe.formArea)})`,
        );
      say(
        `strip bar ${probe.bar === null ? "-" : boxText(probe.bar.rect)}, ring ${probe.ring === null ? "-" : boxText(probe.ring)}, area ${String(probe.formArea)}`,
      );

      // A pictogram writes the edge, and the bar follows the strip.
      const right = probe.bar?.edges.find((edge) => edge.edge === "right");
      if (right !== undefined) {
        await pressAndRelease(client, right.rect.cx, right.rect.cy, "left");
        await settle(client, 600);
        probe = await evaluate(client, PLACEMENT_PROBE);
        await saveShot(client, "placement-strip-right");
        if (probe.placement !== "right" || probe.stripEdge !== "right")
          fail(
            `the right pictogram left the strip at ${String(probe.placement)} (edge ${String(probe.stripEdge)})`,
          );
        checkBar(
          probe,
          "topBar",
          ["top", "left", "right"],
          "right",
          true,
          fail,
        );
        if (
          probe.bar !== null &&
          probe.strip !== null &&
          probe.bar.rect.x + probe.bar.rect.width > probe.strip.x
        )
          fail(
            `on the right, the bar ${boxText(probe.bar.rect)} covers the strip ${boxText(probe.strip)}`,
          );
        say(
          `pictogram -> ${String(probe.placement)}, bar ${probe.bar === null ? "-" : boxText(probe.bar.rect)}`,
        );
      }

      // Dragged by its own space to the left band, then to the top band.
      for (const edge of ["left", "top"]) {
        probe = await evaluate(client, PLACEMENT_PROBE);
        const mid = await dragSurfaceTo(client, probe.spacer, edge);
        probe = await evaluate(client, PLACEMENT_PROBE);
        checkDrop(mid, edge, fail);
        if (probe.placement !== edge)
          fail(
            `dropping the strip on the ${edge} band left it at ${String(probe.placement)}`,
          );
        say(
          `strip dragged to ${edge}: zones ${mid.zones.map((zone) => `${zone.edge}${zone.current ? "*" : ""}${zone.over ? "!" : ""}`).join(" ")}, in hand ${String(mid.dragging)} -> ${String(probe.placement)}`,
        );
      }

      // The sidebar: back to a side strip first, then selected by its empty space.
      await evaluate(client, "window.__layoutCanvasProbe.reset()");
      await evaluate(client, "window.__layoutCanvasProbe.clearSelection()");
      await settle(client, 500);
      probe = await evaluate(client, PLACEMENT_PROBE);
      const asideSpot = {
        cx: probe.aside.cx,
        cy: probe.aside.y + probe.aside.height - 24,
      };
      await pressAndRelease(client, asideSpot.cx, asideSpot.cy, "left");
      await settle(client, 600);
      probe = await evaluate(client, PLACEMENT_PROBE);
      await saveShot(client, "placement-sidebar-bar");
      checkBar(probe, "sidebar", ["left", "right"], "left", false, fail);
      const sidebarRight = probe.bar?.edges.find(
        (edge) => edge.edge === "right",
      );
      if (sidebarRight !== undefined) {
        await pressAndRelease(
          client,
          sidebarRight.rect.cx,
          sidebarRight.rect.cy,
          "left",
        );
        await settle(client, 600);
        probe = await evaluate(client, PLACEMENT_PROBE);
        await saveShot(client, "placement-sidebar-right");
        if (probe.sidebarSide !== "right")
          fail(
            `the right pictogram left the sidebar on the ${String(probe.sidebarSide)}`,
          );
        say(
          `sidebar pictogram -> ${String(probe.sidebarSide)}, bar ${probe.bar === null ? "-" : boxText(probe.bar.rect)}`,
        );
      }
      probe = await evaluate(client, PLACEMENT_PROBE);
      const back = await dragSurfaceTo(
        client,
        { cx: probe.aside.cx, cy: probe.aside.y + probe.aside.height - 24 },
        "left",
      );
      probe = await evaluate(client, PLACEMENT_PROBE);
      checkDrop(back, "left", fail);
      if (probe.sidebarSide !== "left")
        fail(
          `dropping the sidebar on the left band left it on the ${String(probe.sidebarSide)}`,
        );
      say(
        `sidebar dragged to left: zones ${back.zones.map((zone) => `${zone.edge}${zone.current ? "*" : ""}${zone.over ? "!" : ""}`).join(" ")} -> ${String(probe.sidebarSide)}`,
      );

      await evaluate(client, "window.__layoutCanvasProbe.endSession()");
      await settle(client, 400);
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "the strip and the sidebar each selected by their own space, the bar beside them (never over them) with its pictograms checked on the current edge, a pictogram writing the edge, and a drag lighting every zone with the current one marked, lighting the one under the pointer, and writing it on release",
  );
}

const KEY_CODES = { Escape: 27, Enter: 13, ArrowUp: 38 };

/**
 * One real key press, held 60ms as a finger holds it. Radix moves roving
 * focus on a timer and checks a radio only while an arrow is still down, so
 * a zero-length press would test a keyboard no one has.
 */
async function pressKey(client, key) {
  // Enter activates a focused button only when the key event carries its text.
  const event = {
    key,
    code: key,
    windowsVirtualKeyCode: KEY_CODES[key],
    ...(key === "Enter" ? { text: "\r" } : {}),
  };
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

function checkBar(probe, surface, edges, current, views, fail) {
  if (probe.bar === null) {
    fail(`no placement bar for ${surface}`);
    return;
  }
  if (probe.bar.surface !== surface)
    fail(`the bar is for ${probe.bar.surface}, expected ${surface}`);
  const drawn = probe.bar.edges.map((edge) => edge.edge);
  if (drawn.join(",") !== edges.join(","))
    fail(
      `the ${surface} bar offers ${drawn.join(", ")}, expected ${edges.join(", ")}`,
    );
  const checked = probe.bar.edges
    .filter((edge) => edge.checked === "true")
    .map((edge) => edge.edge);
  if (checked.join(",") !== current)
    fail(
      `the ${surface} bar checks ${checked.join(", ") || "nothing"}, expected ${current}`,
    );
  if (probe.bar.views !== views)
    fail(
      `the ${surface} bar ${views ? "lacks" : "carries"} the Tabs view pair`,
    );
  const r = probe.bar.rect;
  if (
    r.x < 0 ||
    r.y < 0 ||
    r.x + r.width > probe.viewport.width ||
    r.y + r.height > probe.viewport.height
  )
    fail(`the ${surface} bar ${boxText(r)} leaves the window`);
  if (probe.ring === null) fail(`no selection ring around the ${surface}`);
}

function checkDrop(mid, edge, fail) {
  if (!mid.dragging)
    fail(`dragging toward ${edge}: the surface in hand is not marked`);
  const over = mid.zones.filter((zone) => zone.over).map((zone) => zone.edge);
  if (over.join(",") !== edge)
    fail(
      `dragging toward ${edge}: the zone under the pointer is ${over.join(", ") || "none"}`,
    );
  if (mid.zones.filter((zone) => zone.current).length !== 1)
    fail(
      `dragging toward ${edge}: ${String(mid.zones.filter((zone) => zone.current).length)} zones marked current`,
    );
}

const DROP_ZONES_PROBE = `(() => ({
  dragging: document.querySelector('[data-layout-surface-dragging="1"]') !== null,
  zones: [...document.querySelectorAll("[data-layout-drop-zone]")].map((node) => {
    const r = node.getBoundingClientRect();
    return { edge: node.getAttribute("data-layout-drop-zone"), current: node.getAttribute("data-current") === "1", over: node.getAttribute("data-over") === "1", cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }),
}))()`;

/** Press on the surface's own space, pass the activation distance, then into the edge's band. */
async function dragSurfaceTo(client, from, edge) {
  await pressAt(client, from.cx, from.cy);
  const armed = { x: from.cx + 12, y: from.cy + 12 };
  await moveInSteps(client, { x: from.cx, y: from.cy }, armed);
  await settle(client, 150);
  const started = await evaluate(client, DROP_ZONES_PROBE);
  const zone = started.zones.find((candidate) => candidate.edge === edge);
  const target = zone === undefined ? armed : { x: zone.cx, y: zone.cy };
  await moveInSteps(client, armed, target);
  await settle(client, 150);
  const mid = await evaluate(client, DROP_ZONES_PROBE);
  await saveShot(client, `placement-drag-${edge}`);
  await releaseAt(client, target.x, target.y);
  await settle(client, 600);
  return mid;
}

// --- groups: a stacked pair is one view group on the panel rail (G3) -------

/**
 * The panel's REAL rail, horizontal across the panel or vertical in the
 * collapsed rail sheet, read as the user meets it: its buttons with their
 * accessible names and lit state, each group with its buttons and count, and
 * the editor's own reading of the same rail (the Sidebar panels list's order
 * in the inspector's Sidebar area).
 */
const RAIL_GROUP_PROBE = `(() => {
  const rail = document.querySelector('[data-testid="epic-sidebar-rail"]');
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  if (rail === null) return null;
  return {
    orientation: rail.getAttribute("data-orientation"),
    buttons: [...rail.querySelectorAll("button")].map((node) => ({
      testId: node.getAttribute("data-testid"),
      label: node.getAttribute("aria-label"),
      current: node.getAttribute("aria-current") === "true",
      rect: box(node),
    })),
    groups: [...rail.querySelectorAll("[data-rail-stack]")].map((node) => {
      const count = node.querySelector('[data-testid="epic-rail-stack-count"]');
      return {
        id: node.getAttribute("data-rail-stack"),
        buttons: node.querySelectorAll("button").length,
        fill: getComputedStyle(node).backgroundColor,
        count: count === null ? null : { text: count.textContent, rect: box(count) },
        button: box(node.querySelector("button")),
      };
    }),
    seams: rail.querySelectorAll('[data-testid="epic-rail-stack-seam"]').length,
    // The Sidebar area's own Panels list (T2/T3), scoped by its group label
    // rather than a region-id prefix: every row now carries the product's own
    // \`data-sortable-id\` (\`layoutRegionRowSelector\`), a stack link's id
    // included, so a link is told apart by its "stack:" prefix instead of a
    // separate attribute.
    index: [...document.querySelectorAll('[data-layout-inspector] [role="group"][aria-label="Sidebar panels"] [data-sortable-id]')].map((node) => {
      const id = node.getAttribute("data-sortable-id") ?? "";
      return id.startsWith("stack:") ? "link:" + id : id;
    }).slice(0, 4),
  };
})()`;

const GROUP_VARIANTS = [
  { label: "left light", sidebar: "left", theme: "light" },
  { label: "right dark", sidebar: "right", theme: "dark" },
];

/**
 * What one group looks like on the rail: exactly one button, the top panel's,
 * named for both members in order, no card behind it and no seam, and a count
 * only while the editor is customizing the rail.
 */
function checkRailGroup(read, expected, fail) {
  if (read === null) {
    fail(`${expected.where}: no panel rail`);
    return;
  }
  if (read.orientation !== expected.orientation)
    fail(
      `${expected.where}: the rail is ${String(read.orientation)}, expected ${expected.orientation}`,
    );
  if (read.groups.length !== 1) {
    fail(
      `${expected.where}: ${String(read.groups.length)} groups on the rail, expected 1`,
    );
    return;
  }
  const group = read.groups[0];
  if (group.id !== expected.id)
    fail(
      `${expected.where}: the group is ${group.id}, expected ${expected.id}`,
    );
  if (group.buttons !== 1)
    fail(
      `${expected.where}: the group draws ${String(group.buttons)} buttons, expected one icon for the pair`,
    );
  if (read.seams !== 0)
    fail(
      `${expected.where}: ${String(read.seams)} separators between grouped icons`,
    );
  if (group.fill !== "rgba(0, 0, 0, 0)")
    fail(`${expected.where}: the group sits on a card (${group.fill})`);
  const top = read.buttons.find(
    (button) => button.testId === expected.topTestId,
  );
  if (top === undefined)
    fail(`${expected.where}: no ${expected.topTestId} icon on the rail`);
  else if (top.label !== expected.label)
    fail(
      `${expected.where}: the group icon is named "${String(top.label)}", expected "${expected.label}"`,
    );
  if (read.buttons.some((button) => button.testId === expected.hiddenTestId))
    fail(
      `${expected.where}: ${expected.hiddenTestId} has its own icon although it is grouped under ${expected.topTestId}`,
    );
  if (expected.count === null) {
    if (group.count !== null)
      fail(
        `${expected.where}: a count "${String(group.count.text)}" on the group at rest`,
      );
  } else if (group.count === null || group.count.text !== expected.count) {
    fail(
      `${expected.where}: the group's count is ${group.count === null ? "missing" : `"${String(group.count.text)}"`}, expected "${expected.count}"`,
    );
  } else if (group.button !== null) {
    const c = group.count.rect;
    const b = group.button;
    if (
      c.width === 0 ||
      c.x < b.x - 0.5 ||
      c.x + c.width > b.x + b.width + 0.5 ||
      c.y < b.y - 0.5 ||
      c.y + c.height > b.y + b.height + 0.5
    )
      fail(
        `${expected.where}: the count ${boxText(c)} is not on its icon ${boxText(b)}`,
      );
  }
}

async function runGroupsPhase(client, pageUrl, pageLoads) {
  await runShellPhase(
    "groups",
    GROUP_VARIANTS,
    async (variant, violations, notes) => {
      const label = `groups ${variant.label}`;
      const loadsAtStart = await openShellVariant(
        client,
        pageUrl,
        pageLoads,
        {
          tabs: "left",
          collapsed: 0,
          wco: "none",
          dock: "right",
          surface: "epic",
          sidebar: variant.sidebar,
          account: 1,
        },
        label,
      );
      const fail = (line) => violations.push(`${label}: ${line}`);
      const say = (line) => notes.push(`${label}: ${line}`);
      const read = () => evaluate(client, RAIL_GROUP_PROBE);
      const shotName = (step) =>
        `groups-${variant.sidebar}-${variant.theme}-${step}`;
      await evaluate(
        client,
        `window.__layoutCanvasProbe.setTheme(${JSON.stringify(variant.theme)})`,
      );
      // The panel's collapse is persisted, so every variant starts expanded.
      await evaluate(
        client,
        "window.__layoutCanvasProbe.setPanelCollapsed(false)",
      );
      await settle(client, 400);
      const agentsOnTop = {
        id: "stack:railAgents+railArtifacts",
        topTestId: "epic-rail-chats",
        hiddenTestId: "epic-rail-artifacts",
        label: "Agents · Artifacts",
      };
      try {
        // At rest: one icon for the pair, lit, named for both.
        let rail = await read();
        checkRailGroup(
          rail,
          {
            ...agentsOnTop,
            where: "at rest",
            orientation: "horizontal",
            count: null,
          },
          fail,
        );
        if (
          rail !== null &&
          rail.buttons.find((button) => button.testId === "epic-rail-chats")
            ?.current !== true
        )
          fail(
            "at rest: the group icon is not lit although Agents is the panel showing",
          );
        await saveShot(client, shotName("rest"));

        // The editor: the icon counts its members and the Sidebar area's
        // Panels list orders them.
        await evaluate(client, "window.__layoutCanvasProbe.beginSession()");
        // Opens the Sidebar area (T3/T4's two-level form) with no row
        // selected, so the Panels list exists in the document to be read.
        await evaluate(
          client,
          'window.__layoutCanvasProbe.openAreaOf("railAgents")',
        );
        await settle(client, 600);
        rail = await read();
        checkRailGroup(
          rail,
          {
            ...agentsOnTop,
            where: "editing",
            orientation: "horizontal",
            count: "2",
          },
          fail,
        );
        const order = [
          "railAgents",
          "link:stack:railAgents+railArtifacts",
          "railArtifacts",
          "railTerminals",
        ];
        if (rail !== null && rail.index.join(",") !== order.join(","))
          fail(
            `the inspector lists ${rail.index.join(", ")}, expected ${order.join(", ")}`,
          );
        await saveShot(client, shotName("editing"));

        // The group's bottom member still keeps its own row in the Panels
        // list (stacking merges the rail's icon, not the settings row). Once
        // it is stacked the rail draws no icon of its own for it, so the row
        // is its click target: opening a row's disclosure selects its region
        // (`toggleRow`), and the selection rings the group's icon, the node
        // that stands for it, never an invisible selection.
        const artifactsRow =
          '[data-layout-inspector] [data-sortable-id="railArtifacts"] [data-row-grab]';
        await evaluate(
          client,
          `document.querySelector(${JSON.stringify(artifactsRow)})?.scrollIntoView({ block: "center" })`,
        );
        await flush(client);
        // Whether the row reads as selected: `data-sortable-selected` on the
        // row and `aria-pressed` on its grab (a row with no disclosure).
        const artifactsSelected = `(() => {
          const grab = document.querySelector(${JSON.stringify(artifactsRow)});
          const row = grab?.closest("[data-sortable-id]");
          return { selected: row?.getAttribute("data-sortable-selected") ?? null, pressed: grab?.getAttribute("aria-pressed") ?? null };
        })()`;
        const row = await rectOf(client, artifactsRow);
        if (row === null) fail("editing: the inspector has no Artifacts row");
        else {
          await pressAt(client, row.cx, row.cy);
          await releaseAt(client, row.cx, row.cy);
          await settle(client, 900);
          const clicked = await evaluate(client, artifactsSelected);
          if (clicked.selected !== "1" || clicked.pressed !== "true")
            fail(
              `Artifacts row clicked: selected=${String(clicked.selected)}, aria-pressed=${String(clicked.pressed)}, expected 1 / true`,
            );
          const ring = await evaluate(client, ringProbe("railAgents"));
          if (ring.error !== null) fail(`Artifacts selected: ${ring.error}`);
          else {
            // `railAgents` sits within RING_BLEED of the top edge, so the
            // ring's own `insideWindow` clamps it there rather than at the
            // raw padded box (`selection-ring.ts`); the switch phase's target
            // is nowhere near an edge, which is why this clamp never showed
            // up there.
            const expected = clampedRingBox(
              {
                x: ring.region.x - RING_PADDING,
                y: ring.region.y - RING_PADDING,
                width: ring.region.width + RING_PADDING * 2,
                height: ring.region.height + RING_PADDING * 2,
              },
              { width: ring.innerWidth, height: ring.innerHeight },
            );
            if (!sameBoxWithin(ring.ring, expected, 1.5))
              fail(
                `Artifacts selected: the ring is at ${boxText(ring.ring)}, expected on the group icon ${boxText(expected)}`,
              );
          }
          await saveShot(client, shotName("bottom-selected"));
          // Enter on the focused grab toggles the selection exactly once per
          // press: from selected, one press clears and the next selects.
          const focusGrab = `document.querySelector(${JSON.stringify(artifactsRow)})?.focus()`;
          for (const expected of [null, "1"]) {
            await evaluate(client, focusGrab);
            await pressKey(client, "Enter");
            await settle(client, 400);
            const state = await evaluate(client, artifactsSelected);
            if (state.selected !== expected)
              fail(
                `Enter on the Artifacts row: selected=${String(state.selected)}, expected ${String(expected)} (one toggle per press)`,
              );
          }
          // Space in this ordered list grabs and drops the row (L-31). The
          // list's keydown takes it, so the button's native keyup click must
          // not also select or clear it: grab plus drop leaves the selection.
          const space = {
            key: " ",
            code: "Space",
            windowsVirtualKeyCode: 32,
            text: " ",
          };
          await evaluate(client, focusGrab);
          for (let press = 0; press < 2; press += 1) {
            await client.send("Input.dispatchKeyEvent", {
              type: "keyDown",
              ...space,
            });
            await delay(60);
            await client.send("Input.dispatchKeyEvent", {
              type: "keyUp",
              ...space,
            });
            await settle(client, 300);
          }
          const afterSpace = await evaluate(client, artifactsSelected);
          if (afterSpace.selected !== "1")
            fail(
              `Space grab and drop on the Artifacts row changed its selection to ${String(afterSpace.selected)}`,
            );
          // Back to the index, which the reorder below reads. Selecting the
          // bottom member opened its own row and left the Sidebar area open
          // (`select` sets the area, `clearSelection` only clears the row).
          await evaluate(client, "window.__layoutCanvasProbe.clearSelection()");
          await settle(client, 400);
        }

        const dividerMoves = await checkDividerRowMoves(client, fail, shotName);
        say(
          `rest, editing count and index, the bottom member's ring and keys, and ${String(dividerMoves)} divider row moves checked`,
        );
        await evaluate(client, "window.__layoutCanvasProbe.endSession()");
        await settle(client, 300);
      } finally {
        await evaluate(client, 'window.__layoutCanvasProbe.setTheme("system")');
        await evaluate(
          client,
          "window.__layoutCanvasProbe.setPanelCollapsed(false)",
        );
      }
      await closeShellVariant(
        client,
        pageLoads,
        loadsAtStart,
        label,
        violations,
      );
    },
    "on both sidebar sides and in both themes a stacked pair draws one icon, the top panel's, with no card or separator; while the editor customizes the rail it paints its member count on the icon, a click on the bottom member's row rings the group icon inside the window, Enter toggles that row once per press and Space grab-and-drop leaves it selected, and a divider added with Add divider moves by a real drag on its grip and on its line and by Space, ArrowUp, Space, each in one history step (the group's labels, lighting, collapse and stack edits are epic-sidebar.test.tsx's and rail-stack-position-list.test.tsx's)",
  );
}

/**
 * A divider added with "+ Add divider" moves like any other row of the
 * Sidebar panels list: a REAL drag taken by its grip, and another by its line,
 * each one history step, then Space, ArrowUp, Space. The grip, the name and
 * the line all sit inside the row's grab `<button>`, which a guard refusing
 * every press inside a button once made undraggable. Returns the moves made.
 */
async function checkDividerRowMoves(client, fail, shotName) {
  const list =
    '[data-layout-inspector] [role="group"][aria-label="Sidebar panels"]';
  const order = () =>
    evaluate(
      client,
      `[...document.querySelectorAll(${JSON.stringify(`${list} > [data-sortable-id]`)})].map((row) => row.getAttribute("data-sortable-id"))`,
    );
  const depth = () =>
    evaluate(client, "window.__layoutCanvasProbe.historyDepth()");
  const added = await evaluate(
    client,
    `(() => {
      const button = [...document.querySelectorAll("[data-layout-inspector] button")].find((node) => node.textContent.trim() === "Add divider");
      button?.click();
      return button !== undefined;
    })()`,
  );
  if (!added) {
    fail("divider moves: the Sidebar panels list has no Add divider");
    return 0;
  }
  await settle(client, 400);
  let moves = 0;
  // Down past the panel below it by the grip, then back up by the line.
  for (const [part, step] of [
    ["[data-row-grip]", 1],
    ["[data-divider-rule]", -1],
  ]) {
    const rows = await order();
    const index = rows.findIndex((id) => id.startsWith("divider:"));
    const neighbour = rows[index + step];
    if (index < 0 || neighbour === undefined) {
      fail(
        `divider moves: no divider with a row beside it in ${rows.join(", ")}`,
      );
      return moves;
    }
    const row = `${list} > [data-sortable-id="${rows[index]}"]`;
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(row)})?.scrollIntoView({ block: "center" })`,
    );
    await flush(client);
    const from = await rectOf(client, `${row} ${part}`);
    const past = await rectOf(
      client,
      `${list} > [data-sortable-id="${neighbour}"]`,
    );
    if (from === null || past === null) {
      fail(`divider moves: the divider row has no ${part}`);
      return moves;
    }
    const before = await depth();
    const mid = await dragPointer(
      client,
      from,
      { x: from.cx, y: step > 0 ? past.y + past.height - 2 : past.y + 2 },
      null,
    );
    const expected = [...rows];
    expected.splice(index, 1);
    expected.splice(index + step, 0, rows[index]);
    const after = await order();
    // A sortable row carries no region or member id, so the lift is read
    // off its transform rather than off `mid.dragging`.
    if (mid.transform === null)
      fail(`divider moves: a real drag by its ${part} never lifted the row`);
    if (after.join(",") !== expected.join(","))
      fail(
        `divider moves: dragged by its ${part}, the list reads ${after.join(", ")}, expected ${expected.join(", ")}`,
      );
    else if ((await depth()) !== before + 1)
      fail(`divider moves: the drag by its ${part} was not one history step`);
    else moves += 1;
    await saveShot(
      client,
      shotName(`divider-drag-${step > 0 ? "down" : "up"}`),
    );
  }
  // The keyboard: Space picks it up, ArrowUp moves it, Space drops it.
  const rows = await order();
  const index = rows.findIndex((id) => id.startsWith("divider:"));
  if (index < 1) {
    fail(`divider moves: no row above the divider in ${rows.join(", ")}`);
    return moves;
  }
  await evaluate(
    client,
    `document.querySelector(${JSON.stringify(`${list} > [data-sortable-id="${rows[index]}"] [data-row-grab]`)})?.focus()`,
  );
  const before = await depth();
  const space = {
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    text: " ",
  };
  for (const key of ["Space", "ArrowUp", "Space"]) {
    if (key === "Space") {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        ...space,
      });
      await delay(60);
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...space });
    } else await pressKey(client, key);
    await settle(client, 200);
  }
  const expected = [...rows];
  expected.splice(index, 1);
  expected.splice(index - 1, 0, rows[index]);
  const after = await order();
  if (after.join(",") !== expected.join(","))
    fail(
      `divider moves: Space, ArrowUp, Space left ${after.join(", ")}, expected ${expected.join(", ")}`,
    );
  else if ((await depth()) !== before + 1)
    fail("divider moves: the keyboard move was not one history step");
  else moves += 1;
  return moves;
}

// --- side placements: shared helpers ---------------------------------------

function selectedPhases() {
  const all = [
    "parity",
    "canvas",
    "sides",
    "switch",
    "strip",
    "sheets",
    "header",
    "running",
    "flip",
    "moves",
    "join",
    "rail",
    "striptop",
    "stripresize",
    "overlays",
    "activity",
    "placement",
    "readings",
    "hostmenu",
    "groups",
  ];
  const raw = process.env.LAYOUT_EDITOR_BROWSER_PHASES;
  const rawShard = process.env.LAYOUT_EDITOR_BROWSER_SHARD;
  const shard = rawShard === undefined ? "" : rawShard.trim();
  if (shard !== "") {
    if (raw !== undefined && raw.trim() !== "") {
      throw new Error(
        "set LAYOUT_EDITOR_BROWSER_PHASES or LAYOUT_EDITOR_BROWSER_SHARD, not both",
      );
    }
    return phaseShard(all, shard);
  }
  if (raw === undefined || raw.trim() === "") return new Set(all);
  const picked = raw
    .split(",")
    .map((phase) => phase.trim())
    .filter((phase) => phase.length > 0);
  for (const phase of picked) {
    if (!all.includes(phase)) {
      throw new Error(
        `unknown phase "${phase}"; the phases are ${all.join(", ")}`,
      );
    }
  }
  return new Set(picked);
}

/**
 * Seconds each phase took on the CI runner (Tests run 36491924268,
 * 2026-09-28), used only to balance LAYOUT_EDITOR_BROWSER_SHARD. A phase
 * missing here weighs `PHASE_CI_SECONDS_DEFAULT`, so a new phase still lands
 * in exactly one shard; re-measure when a shard's job drifts well past the
 * others.
 */
const PHASE_CI_SECONDS = {
  parity: 29,
  canvas: 63,
  sides: 93,
  switch: 11,
  strip: 29,
  sheets: 40,
  header: 61,
  running: 28,
  flip: 52,
  moves: 25,
  join: 49,
  rail: 22,
  striptop: 76,
  stripresize: 29,
  overlays: 22,
  activity: 17,
  placement: 19,
  readings: 103,
  hostmenu: 39,
  groups: 35,
};
const PHASE_CI_SECONDS_DEFAULT = 40;

/**
 * The phases of the k-th of n contiguous slices of `all`. Each phase goes to
 * the slice its weight's midpoint falls in, so the slices partition `all`:
 * every phase runs in exactly one shard.
 */
function phaseShard(all, spec) {
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  const index = match === null ? 0 : Number(match[1]);
  const count = match === null ? 0 : Number(match[2]);
  if (count < 1 || index < 1 || index > count) {
    throw new Error(
      `LAYOUT_EDITOR_BROWSER_SHARD must be k/n with 1 <= k <= n, got "${spec}"`,
    );
  }
  const weights = all.map(
    (phase) => PHASE_CI_SECONDS[phase] ?? PHASE_CI_SECONDS_DEFAULT,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const picked = new Set();
  let before = 0;
  for (const [position, phase] of all.entries()) {
    const weight = weights[position];
    const slice = Math.min(
      count - 1,
      Math.floor(((before + weight / 2) / total) * count),
    );
    if (slice === index - 1) picked.add(phase);
    before += weight;
  }
  if (picked.size === 0) {
    throw new Error(
      `LAYOUT_EDITOR_BROWSER_SHARD ${spec} selects no phase; use fewer shards`,
    );
  }
  return picked;
}

function variantUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, String(value));
  return url.toString();
}

/**
 * A fresh navigation to one variant, and the load count it starts from: the
 * page-load guard re-baselines per variant, so a reload DURING a variant is
 * reported against that variant (critique G4).
 */
async function openVariant(client, url, label, readyExpression, pageLoads) {
  try {
    await navigateInFreshTab(client, url, label, readyExpression, pageLoads);
  } catch (error) {
    // Every load gets a fresh tab (`openTabSession`), which is what removed
    // the tickets/12 stall: one tab navigated from load to load keeps one
    // renderer, which grows to 1-2 GB on these unbundled fixtures and then
    // stops booting (`#root` still empty) or is killed ("Render process
    // gone", after which its CDP session never answers again). Measured on
    // the canvas fixture: 4-6 stalls in 30-40 loads in one tab, 0 in 140 with
    // a tab per load. A stall that still happens is retried ONCE, in another
    // fresh tab, loudly and counted: the run fails on a second one, so a
    // repeat surfaces instead of hiding behind the retry.
    if (!(error instanceof Error) || !stalledBoot(error.message)) throw error;
    stalledBootRetries += 1;
    console.error(
      `\n  WARNING ${label}: the fixture's boot stalled in a fresh tab (${error.message.split("\n")[0]}; renderer ${client.crashed() ? "gone" : "alive"}); retrying once in another fresh tab (retry ${String(stalledBootRetries)}, a second one fails the run).\n`,
    );
    await navigateInFreshTab(client, url, label, readyExpression, pageLoads);
  }
  return pageLoads.count;
}

async function navigateInFreshTab(
  client,
  url,
  label,
  readyExpression,
  pageLoads,
) {
  await client.freshTab();
  await prepareTab(client);
  await navigateAndSettle(client, url, label, readyExpression, pageLoads);
}

/** The tab's own state, which a fresh tab starts without. */
async function prepareTab(client) {
  await client.send("Runtime.enable", undefined);
  await client.send("Page.enable", undefined);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

/**
 * Boots the canvas fixture once before any phase. A `--force` Vite compiles
 * the fixture's whole module graph on its first boot: about 25s on a CI
 * runner, against the 30s every later load is allowed. Since the phases run
 * as separate CI shards, a shard whose first phase opens this fixture paid
 * that cold boot inside its first variant and failed it ("never fired its
 * load event"). So this one boot waits while the dev server keeps answering
 * (compiling is progress), fails after 30s with no response or 180s in all
 * (a reload loop answers forever), and counts as no stall retry. Same
 * semantics as `sheet-join-geometry-browser.mjs`'s `warmUp`.
 */
async function warmUp(client, url) {
  const idleMs = 30_000;
  const capMs = 180_000;
  await client.freshTab();
  await prepareTab(client);
  await client.send("Network.enable", undefined);
  const started = Date.now();
  let lastResponse = started;
  const heard = () => {
    lastResponse = Date.now();
  };
  const stops = [
    client.on("Network.responseReceived", heard),
    client.on("Network.loadingFinished", heard),
  ];
  try {
    await client.send("Page.navigate", { url });
    while (Date.now() - started < capMs) {
      if (client.crashed())
        throw new Error("The renderer was killed while warming up the fixture");
      if (Date.now() - lastResponse >= idleMs)
        throw new Error(
          `The fixture's first boot stalled: no response from Vite for ${String(idleMs / 1000)}s and no ready probe`,
        );
      try {
        if (
          await evaluate(client, "window.__layoutCanvasProbe?.ready === true")
        ) {
          console.log(
            `fixture warm-up boot: ${String(Date.now() - started)}ms`,
          );
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !/context was destroyed|Cannot find context|Inspected target navigated/i.test(
            message,
          )
        )
          throw error;
      }
      await delay(250);
    }
    throw new Error(
      `The fixture's first boot was not ready within ${String(capMs / 1000)}s although Vite kept answering (a reload loop?)`,
    );
  } finally {
    for (const stop of stops) stop();
  }
}

/** A CDP timeout, or a readiness timeout on a document whose module never ran. */
function stalledBoot(message) {
  // `cdp-client.mjs`'s own timeout for a command the page never answers.
  if (/^CDP \S+ got no answer within \d+ms/.test(message)) return true;
  if (message.startsWith("The renderer was killed")) return true;
  return (
    message.startsWith("Timed out waiting for") &&
    message.includes('<div id=\\"root\\"></div>')
  );
}

async function navigateAndSettle(
  client,
  url,
  label,
  readyExpression,
  pageLoads,
) {
  const loadsBefore = pageLoads.count;
  await client.send("Page.navigate", { url });
  // No evaluation until the new document has loaded, so no probe races the
  // navigation's commit.
  const deadline = Date.now() + 30_000;
  while (pageLoads.count === loadsBefore) {
    if (client.crashed())
      throw new Error(`The renderer was killed while loading ${label}`);
    if (Date.now() > deadline)
      throw new Error(`${label} never fired its load event`);
    await delay(25);
  }
  await waitForStablePage(client, label, readyExpression, pageLoads);
}

function assertNoReloadSince(pageLoads, loadsAtStart, label, violations) {
  if (pageLoads.count === loadsAtStart) return;
  violations.push(
    `${label}: the page reloaded ${String(pageLoads.count - loadsAtStart)} time(s) during this variant, so its measurements describe a rebuilt document; re-run with the tree quiet`,
  );
}

async function readFrameGeometry(client) {
  const tokens = await evaluate(
    client,
    `(() => {
      const style = getComputedStyle(document.querySelector("[data-layout-column]"));
      return {
        inset: style.getPropertyValue("--layout-editor-frame-inset").trim(),
        radius: style.getPropertyValue("--layout-editor-frame-radius").trim(),
      };
    })()`,
  );
  return { inset: pxValue(tokens.inset), radius: pxValue(tokens.radius) };
}

/** One painted pixel, read off a 1x1 screenshot. */
async function samplePixelAt(client, x, y) {
  await ensurePixelTools(client);
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1, scale: 1 },
    captureBeyondViewport: false,
  });
  return await evaluate(
    client,
    `window.__samplePixel(${JSON.stringify(shot.data)})`,
  );
}

/** A computed colour as the rgb triple the screenshot would paint it, through a swatch. */
async function resolveRgb(client, cssColor) {
  const spot = await evaluate(
    client,
    `(() => {
      const node = document.createElement("div");
      node.setAttribute("data-colour-swatch", "");
      Object.assign(node.style, { position: "fixed", left: "700px", top: "700px", width: "8px", height: "8px", zIndex: "2147483000", background: ${JSON.stringify(cssColor)} });
      document.body.append(node);
      return { left: 700, top: 700 };
    })()`,
  );
  const pixel = await samplePixelAt(client, spot.left + 4, spot.top + 4);
  await evaluate(
    client,
    `document.querySelector("[data-colour-swatch]")?.remove()`,
  );
  return pixel;
}

/** Middle-half ink pixels against `fill`, or a padding sample when `null`. */
async function inkInside(client, rect, fill) {
  await ensurePixelTools(client);
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      scale: 1,
    },
    captureBeyondViewport: false,
  });
  return await evaluate(
    client,
    `(async () => {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.addEventListener("load", resolve);
        image.addEventListener("error", () => reject(new Error("decode failed")));
        image.src = "data:image/png;base64,${shot.data}";
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      const at = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
      const fill = ${fill === null ? "at(4, Math.floor(height / 2))" : JSON.stringify(fill)};
      let ink = 0;
      for (let y = Math.floor(height / 4); y < Math.ceil((height * 3) / 4); y += 1) {
        for (let x = Math.floor(width / 4); x < Math.ceil((width * 3) / 4); x += 1) {
          const p = at(x, y);
          if (Math.abs(p[0] - fill[0]) + Math.abs(p[1] - fill[1]) + Math.abs(p[2] - fill[2]) > 90) ink += 1;
        }
      }
      return ink;
    })()`,
  );
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(left, right) {
  if (left === null || right === null) return 0;
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturePath = "/src/__tests__/browser/layout-editor-browser.html";
const canvasFixturePath = "/src/__tests__/browser/layout-editor-canvas.html";
const sideStripFixturePath = "/src/__tests__/browser/side-tab-strip.html";
const chromePath = await findChrome("the layout editor parity regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;
/** Fixture loads retried after a stalled boot; see `openVariant`. */
let stalledBootRetries = 0;

try {
  const pageUrl = `http://127.0.0.1:${vitePort}${fixturePath}`;
  viteProcess = await spawnVite(vitePort);
  let viteError = "";
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError += chunk;
  });
  await waitForHttp(pageUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-layout-editor-",
    [
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    ],
  );
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  await waitForHttp(
    new URL("/json/version", launched.devtoolsHttpUrl),
    chrome,
    launched.readError,
    "Chrome DevTools",
  );
  client = await openTabSession(launched.devtoolsHttpUrl);
  await prepareTab(client);
  const pageLoads = { count: 0 };
  // Registered once on the session, so it follows every fresh tab.
  client.on("Page.loadEventFired", () => {
    pageLoads.count += 1;
  });
  const mouseAvailable = await evaluate(
    client,
    'matchMedia("(hover: hover) and (pointer: fine)").matches',
  );
  if (!mouseAvailable) {
    throw new Error(
      "Layout editor mouse regressions require a fine, hovering pointer",
    );
  }
  const origin = `http://127.0.0.1:${vitePort}`;
  const canvasUrl = `${origin}${canvasFixturePath}`;
  const phases = selectedPhases();
  await warmUp(
    client,
    variantUrl(canvasUrl, {
      tabs: "top",
      collapsed: 0,
      wco: "none",
      dock: "right",
    }),
  );
  // Every selected phase runs even after one fails: each navigates to its own
  // document, so a red phase says nothing about the next, and one run should
  // report every red rather than the first.
  const runs = [
    ["parity", () => runParityPhase(client, pageUrl, pageLoads)],
    ["canvas", () => runCanvasPhase(client, canvasUrl, pageLoads)],
    ["sides", () => runSidePlacementPhase(client, canvasUrl, pageLoads)],
    ["switch", () => runLiveSwitchPhase(client, canvasUrl, pageLoads)],
    [
      "strip",
      () =>
        runSideStripDragPhase(
          client,
          `${origin}${sideStripFixturePath}`,
          pageLoads,
        ),
    ],
    ["sheets", () => runSheetsPhase(client, canvasUrl, pageLoads)],
    ["header", () => runHeaderPhase(client, canvasUrl, pageLoads)],
    ["running", () => runRunningPhase(client, canvasUrl, pageLoads)],
    ["flip", () => runFlipPhase(client, canvasUrl, pageLoads)],
    ["moves", () => runMovesPhase(client, canvasUrl, pageLoads)],
    ["join", () => runJoinPhase(client, canvasUrl, pageLoads)],
    ["rail", () => runRailPhase(client, canvasUrl, pageLoads)],
    ["striptop", () => runStripTopPhase(client, canvasUrl, pageLoads)],
    ["stripresize", () => runStripResizePhase(client, canvasUrl, pageLoads)],
    ["overlays", () => runOverlaysPhase(client, canvasUrl, pageLoads)],
    ["activity", () => runActivityPhase(client, canvasUrl, pageLoads)],
    ["placement", () => runPlacementPhase(client, canvasUrl, pageLoads)],
    ["readings", () => runReadingsPhase(client, canvasUrl, pageLoads)],
    ["hostmenu", () => runHostMenuPhase(client, canvasUrl, pageLoads)],
    ["groups", () => runGroupsPhase(client, canvasUrl, pageLoads)],
  ];
  const failures = [];
  for (const [phase, run] of runs) {
    if (!phases.has(phase)) continue;
    try {
      await run();
    } catch (error) {
      failures.push({ phase, error });
      // A crash prints its stack; an assertion's message is its whole report.
      const report =
        error instanceof Error
          ? error.name === "AssertionError"
            ? error.message
            : (error.stack ?? error.message)
          : String(error);
      console.error(`\n[${phase}] FAILED:\n${report}`);
    }
  }
  if (stalledBootRetries > 1) {
    failures.push({
      phase: "fixture boot",
      error: new Error(
        `${String(stalledBootRetries)} fixture loads stalled and were retried in a fresh tab; one is tolerated, a repeat is a regression (see openVariant)`,
      ),
    });
    console.error(
      `\n[fixture boot] FAILED: ${String(stalledBootRetries)} stalled loads`,
    );
  }
  console.log(
    `\nphases run: ${[...phases].join(", ")}; failed: ${failures.length === 0 ? "none" : failures.map((failure) => failure.phase).join(", ")}`,
  );
  if (failures.length > 0) {
    throw new Error(
      `${String(failures.length)} phase run(s) failed: ${failures.map((failure) => failure.phase).join(", ")} (details above)`,
    );
  }
} finally {
  await client?.close();
  if (chrome !== undefined) await terminateProcessTree(chrome);
  viteProcess?.kill("SIGTERM");
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

// --- phase 1: the parity regression -----------------------------------------

async function runParityPhase(client, pageUrl, pageLoads) {
  await client.freshTab();
  await prepareTab(client);
  await client.send("Page.navigate", { url: pageUrl });
  await waitForStablePage(
    client,
    "the layout editor fixture",
    "window.__layoutEditorProbe?.ready === true",
    pageLoads,
  );
  // One frame for the page to settle before it is measured.
  await evaluate(
    client,
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );

  const violations = [];

  const stylesheet = await evaluate(client, STYLESHEET_PROBE);
  if (!stylesheet.loaded) {
    violations.push(
      `layout-editor.css is not in effect (${JSON.stringify(stylesheet)}); every comparison below would pass vacuously`,
    );
  }

  const pictures = await evaluate(client, PICTURE_PROBE);
  for (const region of pictures) {
    if (!region.framed) {
      violations.push(`${region.regionId}: drew no depiction frame`);
    }
  }

  const live = await evaluate(client, LIVE_PROBE);
  if (live.length === 0) {
    violations.push("no live region mounted, so nothing was compared");
  }
  for (const entry of live) {
    if (entry.error !== null) {
      violations.push(`${entry.regionId} live: ${entry.error}`);
      continue;
    }
    for (const property of Object.keys(entry.live)) {
      if (property === "kind") continue;
      if (entry.live[property] !== entry.drawn[property]) {
        violations.push(
          `${entry.regionId} ${entry.live.kind} ${property}: live ${String(entry.live[property])}, picture ${String(entry.drawn[property])}`,
        );
      }
    }
  }

  // The coverage claim itself, stated by the fixture and checked against what
  // is really on the page: a region is either compared live or excused by
  // name, never quietly neither (G3-02, L-85).
  const coverage = await evaluate(client, COVERAGE_PROBE);
  const comparedLive = new Set(live.map((entry) => entry.regionId));
  const uncovered = coverage.regionIds.filter((id) => !comparedLive.has(id));
  for (const regionId of uncovered) {
    if (coverage.noLiveLeaf[regionId] === undefined) {
      // With the DOM beside it: "the element is there and unnamed" and "the
      // surface never rendered it" are different defects, and the message that
      // does not say which cost a whole run to tell apart.
      const trace = await evaluate(
        client,
        `(() => ({
          namedAnywhere: document.querySelectorAll('[data-layout-region="${regionId}"]').length,
          liveSurfaceRegions: [
            ...document.querySelectorAll("[data-live-surface] [data-layout-region]"),
          ].map((node) => node.getAttribute("data-layout-region")),
          toolbarItems: [
            ...document.querySelectorAll("[data-testid^='toolbar-item-']"),
          ].map((node) => node.getAttribute("data-testid")),
        }))()`,
      );
      violations.push(
        `${regionId} has no live node here and no stated reason: mount its real leaf or name it in the fixture's NO_LIVE_LEAF table (${JSON.stringify(trace)})`,
      );
    }
  }
  for (const regionId of Object.keys(coverage.noLiveLeaf)) {
    if (comparedLive.has(regionId)) {
      violations.push(
        `${regionId} is excused in NO_LIVE_LEAF and does have a live node: delete the excuse`,
      );
    }
  }

  // The clip fade on the one picture that can outgrow the inspector (LV2-14).
  // Eight usage providers in a 292px stage is more than fits, and both halves
  // of the answer are real layout that jsdom cannot decide: the MEASURED
  // `data-clipped` (scrollWidth against clientWidth) and the `CLIP_FADE` mask
  // the attribute turns on.
  const clipFade = await evaluate(client, CLIP_FADE_PROBE);
  if (clipFade.error !== null) {
    violations.push(`clip fade: ${clipFade.error}`);
  } else {
    if (clipFade.clipped !== "true") {
      violations.push(
        `clip fade: eight providers in a ${String(clipFade.frameWidth)}px stage measured data-clipped="${String(clipFade.clipped)}" (content ${String(clipFade.scrollWidth)}px in ${String(clipFade.clientWidth)}px)`,
      );
    }
    if (clipFade.mask === "none" || clipFade.mask === "") {
      violations.push(
        `clip fade: the clipped picture resolves no mask-image (got "${clipFade.mask}")`,
      );
    }
  }

  // The attached dock panels, one one-line row each, are the same height to
  // the pixel (L-171): the four members. Waited for rather than read straight off: two
  // of them boot a host runtime before they draw a row, so an unwaited read
  // would measure the runtime's fallback and call the nulls equal. The count
  // is read off the page rather than written down here, because a member is
  // exactly the thing this file should not be the register of.
  await waitFor(
    client,
    "the four attached dock panels to draw their one row each",
    `document.querySelectorAll("[data-dock-row-metric] [data-testid='chat-dock-attached-panel']").length === document.querySelectorAll("[data-dock-row-metric]").length && document.querySelectorAll("[data-dock-row-metric]").length > 0`,
  );
  const dockRows = await evaluate(client, DOCK_ROW_METRIC_PROBE);
  const dockRowReport = dockRows.rows
    .map((row) => `${row.section} ${String(row.height)}px/${String(row.rows)}`)
    .join(", ");
  const dockRowHeights = new Set(dockRows.rows.map((row) => row.height));
  if (dockRowHeights.size !== 1) {
    violations.push(
      `the attached dock panels do not share one row metric: ${dockRowReport}`,
    );
  }
  // Not vacuously: every panel drew the one row it was fed, and the shared
  // height is more than an empty list's inset.
  for (const row of dockRows.rows) {
    if (row.rows === 1) continue;
    violations.push(
      `${String(row.section)} drew ${String(row.rows)} rows, expected exactly 1: ${dockRowReport}`,
    );
  }
  for (const height of dockRowHeights) {
    if (height !== null && height > DOCK_ROW_METRIC_LIST_INSET) continue;
    violations.push(
      `the attached dock panels measured ${String(height)}px, which is no more than an empty list's ${String(DOCK_ROW_METRIC_LIST_INSET)}px inset: ${dockRowReport}`,
    );
  }

  const presetCards = await evaluate(client, PRESET_CARDS_PROBE);
  if (presetCards.count === 0) violations.push("no preset cards rendered");
  if (presetCards.count > 0 && !presetCards.oneRow)
    violations.push("preset cards wrap, expected one row at 380px");
  if (presetCards.unpictured.length > 0)
    violations.push(
      `preset cards without exactly one miniature: ${presetCards.unpictured.join(", ")}`,
    );
  if (presetCards.untitled.length > 0)
    violations.push(
      `preset cards with no text: ${presetCards.untitled.join(", ")}`,
    );

  await evaluate(client, "window.__layoutEditorProbe.showChip()");
  await evaluate(
    client,
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const chip = await evaluate(client, CHIP_PROBE);
  if (chip.error !== null) {
    violations.push(`hover chip: ${chip.error}`);
  } else {
    if (chip.anchored !== "1") {
      violations.push(
        `hover chip took the measured fallback (data-anchored=${chip.anchored}); this Chrome resolves no anchor positioning, so the painted position below proves nothing`,
      );
    }
    // Chrome serialises `block-start center` in its physical-agnostic short
    // form, so both spellings mean the rule in `layout-editor.css` took.
    if (!["block-start center", "start center"].includes(chip.positionArea)) {
      violations.push(
        `hover chip position-area: expected the block-start centre area, got "${chip.positionArea}"`,
      );
    }
    // Painted, not computed: where Chrome actually put the box relative to
    // the element it is anchored to.
    if (Math.abs(chip.gapBelow - chip.margin) > 1) {
      violations.push(
        `hover chip sits ${chip.gapBelow.toFixed(2)}px above its region, expected ${chip.margin}px`,
      );
    }
    if (Math.abs(chip.centreOffset) > 1) {
      violations.push(
        `hover chip is ${chip.centreOffset.toFixed(2)}px off its region's centre`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Layout editor parity regression failed:\n${JSON.stringify(
      { violations, stylesheet, dockRows, presetCards, chip },
      null,
      2,
    )}`,
  );
  console.log(
    `layout editor parity regression passed: ${String(pictures.length)} pictures, ${String(live.length)} compared against a live leaf (${live.map((entry) => `${entry.regionId}/${entry.live.kind}`).join(", ")})`,
  );
  console.log(
    `no live leaf in this fixture for ${String(uncovered.length)} region(s), each with a stated reason:\n${uncovered
      .map((regionId) => `  - ${regionId}: ${coverage.noLiveLeaf[regionId]}`)
      .join("\n")}`,
  );
}

// --- process plumbing -------------------------------------------------------

/**
 * This run's own Vite, serving the tree as it is when the run starts.
 *
 * File watching is off, through a wrapper config around the shared one: every
 * run starts its own server, so it never needs to follow an edit, and in a
 * tree several agents write at once a watcher reloads the fixture mid-phase on
 * a peer's save, which fails the phase at whatever step it was on with the
 * probe gone. HMR itself stays on: it is the channel the cold dependency
 * optimizer (`--force`) reloads the first boot through.
 */
async function spawnVite(port) {
  const configDir = await mkdtemp(path.join(tmpdir(), "layout-editor-vite-"));
  const configPath = path.join(configDir, "vite.no-watch.config.mjs");
  await writeFile(
    configPath,
    [
      `import base from ${JSON.stringify(path.join(projectRoot, "vitest.config.ts"))};`,
      "export default { ...base, server: { ...base.server, watch: null } };",
      "",
    ].join("\n"),
  );
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  const child = spawn(
    "node",
    [
      viteEntry,
      "--config",
      configPath,
      "--host",
      "127.0.0.1",
      "--force",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.once("exit", () => {
    void rm(configDir, { recursive: true, force: true });
  });
  return child;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a free Vite port"));
        return;
      }
      server.close();
      resolve(address.port);
    });
  });
}

async function waitForHttp(url, child, readError, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} exited before ready:\n${readError()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local server has not opened its port yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}:\n${readError()}`);
}

async function evaluate(targetClient, expression) {
  const response = await targetClient.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Browser evaluation failed",
    );
  }
  return response.result.value;
}

/**
 * Ready, and STILL ready once the page has had a moment to reload under us.
 *
 * Vite re-optimizes dependencies on a cold `--force` start and answers with a
 * full page reload, which can land after the fixture has already reported
 * ready. The probes then run against a document that is being torn down and
 * rebuilt, and whichever region has not re-registered yet reads as absent.
 * Measured: a run died twenty assertions in as
 * `window.__swatch is not a function`, because a save in another window had
 * reloaded the page and taken every injected helper with it. The load event
 * is the edge; waiting for a quiet window after it is the whole fix, and a
 * reload that lands mid-phase is reported rather than absorbed.
 */
async function waitForStablePage(targetClient, label, expression, pageLoads) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await waitFor(targetClient, label, expression);
    const seen = pageLoads.count;
    await delay(700);
    if (pageLoads.count === seen && (await evaluate(targetClient, expression)))
      return;
  }
  throw new Error(`${label} kept reloading and never settled`);
}

async function waitFor(targetClient, label, expression) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (targetClient.crashed())
      throw new Error(`The renderer was killed while waiting for ${label}`);
    if (await evaluate(targetClient, expression)) return;
    await delay(50);
  }
  const state = await evaluate(
    targetClient,
    `({ body: document.body.innerHTML.slice(0, 4000), viteError: document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? "",
      fixtureModuleRan: Array.isArray(window.__layoutCanvasErrors),
      fixtureErrors: window.__layoutCanvasErrors,
      rootProperties: Object.keys(document.getElementById("root") ?? {}),
      resources: performance.getEntriesByType("resource").slice(-5).map(({name, duration, responseStatus}) => ({name, duration, responseStatus})),
    })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(state, null, 2)}`,
  );
}

// --- phase 2: the canvas interaction regression -----------------------------

async function runCanvasPhase(client, pageUrl, pageLoads) {
  const violations = [];
  const notes = [];
  const fileChoosers = [];
  const stopWatchingChoosers = client.on("Page.fileChooserOpened", (params) => {
    fileChoosers.push(params);
  });

  const loadsAtStart = await openVariant(
    client,
    pageUrl,
    "the layout editor canvas fixture",
    "window.__layoutCanvasProbe?.ready === true",
    pageLoads,
  );
  await client.send("Page.setInterceptFileChooserDialog", { enabled: true });
  await evaluate(client, INSTALL_PIXEL_TOOLS);
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await evaluate(client, "window.__layoutCanvasProbe.beginSession()");
  await flush(client);
  await delay(400);
  await flush(client);
  await saveShot(client, "canvas-arrival");

  const coverage = await evaluate(
    client,
    `(() => ({
      regionIds: window.__layoutCanvasProbe.regionIds,
      noCanvasNode: window.__layoutCanvasProbe.noCanvasNode,
      names: window.__layoutCanvasProbe.names,
      errors: window.__layoutCanvasErrors,
    }))()`,
  );
  if (coverage.errors.length > 0) {
    violations.push(
      `the fixture raised ${String(coverage.errors.length)} uncaught error(s):\n${coverage.errors.join("\n")}`,
    );
  }
  for (const regionId of coverage.regionIds) {
    const drawn = CANVAS_REGIONS.includes(regionId);
    const excused = coverage.noCanvasNode[regionId] !== undefined;
    if (drawn === excused) {
      violations.push(
        `${regionId}: the driver says drawn=${String(drawn)} and the fixture says excused=${String(excused)}; one of them is wrong`,
      );
    }
  }
  const mountedRegions = CANVAS_REGIONS.filter((regionId) =>
    coverage.regionIds.includes(regionId),
  );
  for (const regionId of CANVAS_REGIONS) {
    if (!mountedRegions.includes(regionId))
      notes.push(
        `${regionId} is no longer a region in this build; not asserted`,
      );
  }

  // --- A3. A real mouseMoved hovers it and raises the chip ------------------
  // Real input onto each region's centre: an `inert` subtree, an overlay or a
  // sibling region painted over it all leave its data-hover unset. (That the
  // scene carries no `inert` is sample-workspace-surface.test.tsx's; the
  // chip's words and anchored position are jsdom's and the parity phase's.)
  for (const regionId of mountedRegions) {
    const box = await rectOf(client, regionSelector(regionId));
    if (box === null) {
      violations.push(`A3 ${regionId}: no node`);
      continue;
    }
    await moveTo(client, box.cx, box.cy);
    await flush(client);
    const hover = await evaluate(client, hoverProbe(regionId));
    if (hover.error !== null) {
      violations.push(`A3 ${regionId}: ${hover.error}`);
      continue;
    }
    if (hover.hover !== "1") {
      violations.push(
        `A3 ${regionId}: a real mouseMoved onto (${box.cx.toFixed(0)}, ${box.cy.toFixed(0)}) left data-hover=${String(hover.hover)}`,
      );
    }
    if (hover.chipHidden || hover.chipRect === null) {
      violations.push(
        `A3 ${regionId}: no name chip on screen (hidden=${String(hover.chipHidden)})`,
      );
    }
  }
  await moveTo(client, 4, 4);
  await evaluate(client, "window.__layoutCanvasProbe.clearSelection()");
  await flush(client);

  // --- A4. A real click selects, and the app does not act -------------------
  for (const regionId of mountedRegions) {
    const box = await rectOf(client, regionSelector(regionId));
    if (box === null) {
      violations.push(`A4 ${regionId}: no node`);
      continue;
    }
    await moveTo(client, box.cx, box.cy);
    await flush(client);
    const before = await evaluate(client, APP_ACTED_PROBE);
    const choosersBefore = fileChoosers.length;
    await pressAndRelease(client, box.cx, box.cy, "left");
    await flush(client);
    await delay(60);
    const after = await evaluate(client, APP_ACTED_PROBE);
    const selected = await evaluate(client, selectionProbe(regionId));
    if (selected.selected !== "1") {
      violations.push(
        `A4 ${regionId}: a real click at (${box.cx.toFixed(0)}, ${box.cy.toFixed(0)}) left data-selected=${String(selected.selected)}`,
      );
    }
    if (selected.atIndex) {
      violations.push(
        `A4 ${regionId}: the inspector is still on its index, so the click opened no section`,
      );
    } else if (
      !String(selected.inspectorText).includes(coverage.names[regionId])
    ) {
      violations.push(
        `A4 ${regionId}: the inspector section does not name it; it reads "${String(selected.inspectorText).slice(0, 120)}"`,
      );
    }
    if (after.layers !== 0) {
      violations.push(
        `A4 ${regionId}: the click opened ${String(after.layers)} menu/dialog/popover layer(s) - the app acted`,
      );
    }
    if (after.expanded !== before.expanded || after.states !== before.states) {
      violations.push(
        `A4 ${regionId}: the click toggled an app control (aria-expanded "${before.expanded}" -> "${after.expanded}", data-state "${before.states}" -> "${after.states}")`,
      );
    }
    if (fileChoosers.length !== choosersBefore) {
      violations.push(
        `A4 ${regionId}: the click opened a file chooser (${JSON.stringify(fileChoosers.at(-1))})`,
      );
    }
  }

  // --- A5. Seven real drags, each one history step --------------------------
  const baseline = await evaluate(
    client,
    "window.__layoutCanvasProbe.snapshot()",
  );
  const dragPlans = buildDragPlans(
    baseline.arrangement.toolbarLeft,
    baseline.arrangement.dock,
  );
  for (const plan of dragPlans) {
    const result = await runDrag(client, plan);
    violations.push(...result.violations);
    notes.push(...result.notes);
  }

  // --- A6. The mic chip hidden, and its ghost -------------------------------
  // Shown is the shipped preset's, which A3 and A4 already point at.
  await resetSession(client);
  await evaluate(client, "window.__layoutCanvasProbe.setMicShown(false)");
  await flush(client);
  const micHidden = await rectOf(client, regionSelector("mic"));
  if (micHidden !== null) {
    violations.push(
      `A6: Microphone Hidden left the chip on the canvas at ${boxText(micHidden)}`,
    );
  }
  const micGhost = await hoverIndexRow(client, "mic");
  if (micGhost.error !== null) violations.push(`A6 ghost: ${micGhost.error}`);
  else {
    if (micGhost.ghost !== "1") {
      violations.push(
        `A6 ghost: a real hover on the Microphone index row left data-ghost=${String(micGhost.ghost)}`,
      );
    }
    if (micGhost.rect === null || micGhost.rect.width === 0) {
      violations.push(
        `A6 ghost: the materialised mic has no box (${JSON.stringify(micGhost.rect)})`,
      );
    }
  }

  // --- A7. A Hidden + Chip dock member ghosts as a PILL ---------------------
  await resetSession(client);
  await evaluate(client, "window.__layoutCanvasProbe.hideChangedFilesAsChip()");
  await flush(client);
  const pillGhost = await hoverIndexRow(client, "changedFiles");
  if (pillGhost.error !== null) violations.push(`A7: ${pillGhost.error}`);
  else {
    if (pillGhost.ghost !== "1") {
      violations.push(
        `A7: a real hover on the Changed files index row left data-ghost=${String(pillGhost.ghost)}`,
      );
    }
    if (!pillGhost.inCompactStrip) {
      violations.push(
        `A7: the ghost materialised outside the compact strip, so a Hidden + Chip member is being previewed as the row it never takes (cluster=${String(pillGhost.cluster)})`,
      );
    }
    if (pillGhost.rect !== null && pillGhost.rect.height > 40) {
      violations.push(
        `A7: the ghost is ${String(Math.round(pillGhost.rect.height))}px tall, which is a row rather than a pill`,
      );
    }
  }

  // --- A8. Quick verbs, in a session and at rest ----------------------------
  await resetSession(client);
  await evaluate(client, "window.__layoutCanvasProbe.setMicShown(true)");
  await flush(client);
  const micBox = await rectOf(client, regionSelector("mic"));
  if (micBox === null) violations.push("A8: no mic region to right-click");
  else {
    const inSession = await rightClickMenu(client, micBox.cx, micBox.cy);
    if (!inSession.open) {
      violations.push(
        "A8: a real right-click on the mic INSIDE a session opened no [role=menu]",
      );
    } else if (!inSession.text.includes(coverage.names.mic)) {
      violations.push(
        `A8: the in-session menu does not name Microphone; it reads "${inSession.text.slice(0, 120)}"`,
      );
    }
    await dismissLayers(client);

    // A point on the prose of a turn that is on screen - the conversation
    // opens at its end, so the first turn is scrolled out - and on no region,
    // or the firewall's silence would be the region menu's absence.
    const prose = await evaluate(
      client,
      `(() => {
        for (const turn of [...document.querySelectorAll("[data-sample-turn]")].reverse()) {
          const r = turn.getBoundingClientRect();
          for (let fy = 0.1; fy < 1; fy += 0.1) {
            for (let fx = 0.1; fx < 1; fx += 0.1) {
              const x = r.left + r.width * fx;
              const y = r.top + r.height * fy;
              if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
              const hit = document.elementFromPoint(x, y);
              if (hit !== null && turn.contains(hit) && hit.closest("[data-layout-region]") === null)
                return { x, y };
            }
          }
        }
        return null;
      })()`,
    );
    if (prose === null)
      violations.push("A8: no on-screen transcript prose outside a region");
    else {
      const onProse = await rightClickMenu(client, prose.x, prose.y);
      if (onProse.open) {
        violations.push(
          `A8: a right-click on the sample transcript opened a menu ("${onProse.text.slice(0, 120)}"); the firewall should swallow it`,
        );
      }
      await dismissLayers(client);
    }

    await evaluate(client, "window.__layoutCanvasProbe.endSession()");
    await flush(client);
    await delay(200);
    // Not the named element's own rect: outside a session `ComposerMicSlot`
    // draws its wrapper `display: contents`, so the element that CARRIES the
    // region name has no box at all. That is the shipped shape (the box only
    // exists while the ring and the hover outline need one), and the product
    // still resolves the region because the menu walks `closest` up from the
    // real control - which is what this point has to be on.
    const atRestBox = await pointInside(client, regionSelector("mic"));
    if (atRestBox === null) {
      violations.push(
        "A8: the mic lost its region name when the session ended, so a right-click at rest can no longer resolve it (L-129)",
      );
    } else {
      notes.push(
        `at rest the mic's named element is ${atRestBox.boxless ? "box-less (display: contents), so the right-click lands on its control" : "a real box"}`,
      );
      const atRest = await rightClickMenu(client, atRestBox.x, atRestBox.y);
      if (!atRest.open) {
        violations.push(
          "A8: a real right-click on the mic AT REST opened no [role=menu] (L-19)",
        );
      } else if (!atRest.text.includes(coverage.names.mic)) {
        violations.push(
          `A8: the at-rest menu does not name Microphone; it reads "${atRest.text.slice(0, 120)}"`,
        );
      }
      await dismissLayers(client);
    }
  }

  // Every region that can be pointed at offers its verbs (L-144).
  //
  // These three were the measurement that found the gap: `region-quick-verbs.tsx`
  // was rendered by five call sites only - the two composer toolbar clusters,
  // the header's usage chip, the tab strip's Home item and the status bar's
  // visibility menu - so the dock's pills and rows, the sample rail's icons
  // and the minimap had no trigger to open one, session or not. They now do:
  // one cluster menu for the pill strip, one for the dock's joined frame, the
  // real rail's own menu on the sample rail, and a region menu on the minimap.
  //
  // A session is restarted per region because dismissing a menu that never
  // opened is an Escape the EDITOR owns, which would end the session.
  for (const regionId of ["changedFiles", "railBrowsers", "minimap"]) {
    await resetSession(client);
    const box = await rectOf(client, regionSelector(regionId));
    if (box === null) {
      violations.push(`A8: no ${regionId} on the canvas to right-click`);
      continue;
    }
    // A menu left over from the region before would answer for this one.
    if (
      await evaluate(client, `document.querySelector('[role="menu"]') !== null`)
    )
      violations.push(
        `A8: a menu is already open before right-clicking ${regionId}`,
      );
    const menu = await rightClickMenu(client, box.cx, box.cy);
    if (!menu.open)
      violations.push(
        `A8: a real right-click on ${regionId} inside a session opened no [role=menu] (L-144)`,
      );
    else if (!menu.text.includes(coverage.names[regionId]))
      violations.push(
        `A8: the menu on ${regionId} does not name ${coverage.names[regionId]}; it reads "${menu.text.slice(0, 120)}"`,
      );
    else notes.push(`quick-verb menu on ${regionId}: opens`);
    await dismissLayers(client);
  }

  // --- A9. The editing frame, counted in pixels -----------------------------
  await resetSession(client);
  const target = await sampleAmber(client);
  if (target === null) {
    violations.push("A9: could not sample the --warning-foreground colour");
  } else {
    notes.push(`--warning-foreground paints as rgb(${target.join(", ")})`);
    // Where the stylesheet put the stroke, read off the column rather than
    // restated here (see `countEdge`); `pxValue` refuses anything but plain
    // px, so a `0.25rem` cannot silently read as a regression.
    const frame = await readFrameGeometry(client);
    if (frame.inset === null || frame.radius === null) {
      violations.push(
        `A9: the frame's geometry is not a plain px value, so nothing below measured where the stroke actually is; the counts fall back to L-137's ${String(DESIGNED_FRAME_INSET)}px and ${String(DESIGNED_FRAME_RADIUS)}px`,
      );
      frame.inset = frame.inset ?? DESIGNED_FRAME_INSET;
      frame.radius = frame.radius ?? DESIGNED_FRAME_RADIUS;
    } else if (
      frame.inset !== DESIGNED_FRAME_INSET ||
      frame.radius !== DESIGNED_FRAME_RADIUS
    ) {
      violations.push(
        `A9: the frame is inset ${String(frame.inset)}px with a ${String(frame.radius)}px radius, expected ${String(DESIGNED_FRAME_INSET)}px and ${String(DESIGNED_FRAME_RADIUS)}px (L-137)`,
      );
    }
    notes.push(
      `editing frame is inset ${String(frame.inset)}px with a ${String(frame.radius)}px radius; each edge's straight run is counted at that inset`,
    );
    for (const mode of ["right", "left", "float"]) {
      await evaluate(
        client,
        `window.__layoutCanvasProbe.setDockMode(${JSON.stringify(mode)})`,
      );
      await flush(client);
      await delay(450);
      await flush(client);
      const column = await rectOf(client, "[data-layout-column]");
      if (column === null) {
        violations.push(`A9 ${mode}: no app column`);
        continue;
      }
      for (const edge of ["top", "bottom", "left", "right"]) {
        const count = await countEdge(client, column, edge, target, frame);
        const ratio = count.along === 0 ? 0 : count.lit / count.along;
        notes.push(
          `frame ${mode}/${edge}: ${String(count.lit)}/${String(count.along)} lit (${(ratio * 100).toFixed(1)}%)`,
        );
        if (ratio < FRAME_LIT_FLOOR || ratio > FRAME_LIT_CEILING) {
          violations.push(
            `A9 ${mode}/${edge}: ${String(count.lit)} of ${String(count.along)} positions along the straight run of that edge are amber (${(ratio * 100).toFixed(1)}%, expected a dotted ${String(FRAME_LIT_FLOOR * 100)}-${String(FRAME_LIT_CEILING * 100)}%); column ${boxText(column)}`,
          );
        }
        const quarters = count.quarters ?? [];
        notes.push(
          `frame ${mode}/${edge} quarters: ${quarters
            .map((quarter) =>
              quarter.along === 0
                ? "-"
                : `${((quarter.lit / quarter.along) * 100).toFixed(0)}%`,
            )
            .join(" ")}`,
        );
        for (const [index, quarter] of quarters.entries()) {
          if (quarter.along === 0) continue;
          const share = quarter.lit / quarter.along;
          if (share >= FRAME_QUARTER_LIT_FLOOR) continue;
          violations.push(
            `A9 ${mode}/${edge}: quarter ${String(index + 1)} of that edge's straight run is ${(share * 100).toFixed(1)}% amber (expected at least ${String(FRAME_QUARTER_LIT_FLOOR * 100)}%), so part of the edge is covered or missing; column ${boxText(column)}`,
          );
        }
      }
      // The four corners, which the edge counts above cut out by construction
      // (`countEdge` starts each run at `inset + radius`). Nothing in those
      // counts can tell a 12px arc from a square join, so this asks the one
      // question that can be asked of a pixel: is the corner of the frame's
      // own RECTANGLE dark, as only a rounded corner leaves it.
      for (const corner of [
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
      ]) {
        const cornerX = corner.endsWith("left")
          ? column.x + frame.inset
          : column.x + column.width - frame.inset;
        const cornerY = corner.startsWith("top")
          ? column.y + frame.inset
          : column.y + column.height - frame.inset;
        const ink = await countBox(
          client,
          {
            x: cornerX - FRAME_CORNER_PROBE / 2,
            y: cornerY - FRAME_CORNER_PROBE / 2,
            width: FRAME_CORNER_PROBE,
            height: FRAME_CORNER_PROBE,
          },
          target,
        );
        notes.push(
          `frame ${mode}/${corner} square-corner probe: ${String(ink.lit)}/${String(ink.along)} amber`,
        );
        if (ink.lit > 0) {
          violations.push(
            `A9 ${mode}/${corner}: amber ink at the frame's own rectangle corner (${String(ink.lit)} of ${String(ink.along)} columns), which a ${String(frame.radius)}px radius cannot produce (L-137); the box is 4px square at the corner and anything painted there will report, so read the pixels before reading the border-radius; column ${boxText(column)}`,
          );
        }
      }
    }
    await evaluate(client, 'window.__layoutCanvasProbe.setDockMode("right")');
    await flush(client);
    await delay(400);

    // The editor's own top TAB under that run (L-163): the real `TabChrome`
    // in its session state, filled with the editing colour and edged in
    // anything but it, read as resolved colours through one element so a
    // `light-dark()` token compares as what it paints. The side strip's
    // session row is another component (`checkSessionRow`).
    const tab = await evaluate(
      client,
      `(() => {
        const box = document.querySelector('[data-fixture-session-tab] [data-testid="tab-chrome-box"]');
        if (box === null) return null;
        const probe = document.createElement("span");
        box.append(probe);
        const resolve = (value) => {
          probe.style.color = "";
          probe.style.color = value;
          return getComputedStyle(probe).color;
        };
        const style = getComputedStyle(box);
        const read = {
          amber: resolve("var(--warning-foreground)"),
          fill: resolve(style.backgroundColor),
          edges: ["Top", "Right", "Bottom", "Left"].map((side) => resolve(style["border" + side + "Color"])),
        };
        probe.remove();
        return read;
      })()`,
    );
    if (tab === null) violations.push("A9 tab: no session tab chrome");
    else {
      notes.push(`session tab fill ${tab.fill}, edges ${tab.edges.join(" ")}`);
      if (tab.fill !== tab.amber)
        violations.push(
          `A9 tab: the editor's tab is filled ${tab.fill}, not the editing colour ${tab.amber} (L-163)`,
        );
      if (tab.edges.includes(tab.amber))
        violations.push(
          `A9 tab: the editor's tab is edged in the editing colour ${tab.amber}, a ring the frame's own line runs into (L-163)`,
        );
    }
  }

  // A document rebuilt under the probes is not the one these numbers describe.
  assertNoReloadSince(pageLoads, loadsAtStart, "canvas", violations);
  stopWatchingChoosers();
  await client.send("Page.setInterceptFileChooserDialog", { enabled: false });

  console.log(`\n--- canvas interaction regression ---`);
  for (const note of notes) console.log(`  ${note}`);
  assert.deepEqual(
    violations,
    [],
    `Layout editor canvas interaction regression failed (${String(violations.length)}):\n${violations.map((line) => `  - ${line}`).join("\n")}\n\nmeasurements:\n${notes.map((line) => `  ${line}`).join("\n")}`,
  );
  console.log(
    `layout editor canvas interaction regression passed: ${String(mountedRegions.length)} regions pointed at, hovered and selected with real mouse input; ${String(dragPlans.length)} real drags; the editing frame counted on 12 column edges`,
  );
  console.log(
    `no node on this canvas for ${String(Object.keys(coverage.noCanvasNode).length)} region(s), each with a stated reason:\n${Object.entries(
      coverage.noCanvasNode,
    )
      .map(([regionId, reason]) => `  - ${regionId}: ${reason}`)
      .join("\n")}`,
  );
}

// --- phase 2: page-side probes ---------------------------------------------

function regionSelector(regionId) {
  // Timestamps are the one region drawn once per message, and the first in
  // the document is the oldest prompt, scrolled out of a conversation that
  // opens at its end. The last turn's stamp is the one on screen, which is
  // also the one the editor's chip and ring go to (`preferredRegionInstance`).
  if (regionId === "timestamps")
    return `[data-sample-turn]:last-child [data-layout-region="timestamps"]`;
  return `[data-layout-region="${regionId}"]`;
}

function hoverProbe(regionId) {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(regionSelector(regionId))});
    const chip = document.querySelector("[data-layout-hover-chip]");
    if (node === null) return { error: "the region has no node on the canvas" };
    const chipRect = chip === null || chip.hidden ? null : chip.getBoundingClientRect();
    return {
      error: null,
      hover: node.getAttribute("data-hover"),
      chipHidden: chip === null ? true : chip.hidden,
      chipRect:
        chipRect === null
          ? null
          : { x: chipRect.x, y: chipRect.y, width: chipRect.width, height: chipRect.height },
    };
  })()`;
}

function selectionProbe(regionId) {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(regionSelector(regionId))});
    const panel = document.querySelector("[data-layout-inspector]");
    return {
      selected: node === null ? null : node.getAttribute("data-selected"),
      // The two-level form: a click opens the region's area with its row
      // selected, so "still at the index" is no area form on screen.
      atIndex: panel !== null && panel.querySelector("[data-layout-area-form]") === null,
      inspectorText: (() => {
        const row = panel === null ? null : panel.querySelector('[data-sortable-id=${JSON.stringify(regionId)}][data-sortable-selected="1"]');
        return row === null ? "" : (row.textContent ?? "").slice(0, 400);
      })(),
    };
  })()`;
}

function ringProbe(regionId) {
  return `(() => {
    const ring = document.querySelector("[data-layout-selection-ring]");
    const node = document.querySelector(${JSON.stringify(regionSelector(regionId))});
    if (ring === null) return { error: "no selection ring in the document" };
    if (node === null) return { error: "the selected region has no node" };
    if (ring.hidden) return { error: "the selection ring is hidden" };
    const ringRect = ring.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    return {
      error: null,
      on: ring.getAttribute("data-on"),
      ring: { x: ringRect.x, y: ringRect.y, width: ringRect.width, height: ringRect.height },
      region: { x: nodeRect.x, y: nodeRect.y, width: nodeRect.width, height: nodeRect.height },
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  })()`;
}

// --- phase 2: real input ----------------------------------------------------

async function moveTo(client, x, y) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    clickCount: 0,
    pointerType: "mouse",
  });
}

async function pressAndRelease(client, x, y, button) {
  const buttons = button === "right" ? 2 : 1;
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons,
    clickCount: 1,
    pointerType: "mouse",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
}

/**
 * A press, sixteen moves, a beat, and a release, with the canvas read while
 * the member is still in hand.
 *
 * Sixteen rather than one, because `armLayoutDrag` only starts a drag once the
 * press has TRAVELLED (`dragStarted`, 6px Manhattan) and the reflow is driven
 * by the moves after that; a single jump would arm and drop in the same event.
 *
 * The canvas is read after the LAST move rather than partway through, and
 * after a beat: a sibling steps aside on its own spring
 * (`DRAG_SIBLING_SPRING`, 0.34s response), and the member only claims a new
 * slot once its centre has passed the neighbour's - which is the last few
 * pixels of the gesture, not the middle of it.
 */
async function dragPointer(client, from, to, siblingSelector) {
  const steps = 16;
  await moveTo(client, from.cx, from.cy);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.cx,
    y: from.cy,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
  for (let step = 1; step <= steps; step += 1) {
    const x = from.cx + ((to.x - from.cx) * step) / steps;
    const y = from.cy + ((to.y - from.cy) * step) / steps;
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 0,
      pointerType: "mouse",
    });
  }
  await delay(220);
  await flush(client);
  const mid = await evaluate(client, midDragProbe(siblingSelector));
  mid.pointer = to;
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
  // The release is a spring, and the write happens only once it has settled.
  await delay(900);
  await flush(client);
  return mid;
}

function midDragProbe(siblingSelector) {
  const sibling =
    siblingSelector === null ? "null" : JSON.stringify(siblingSelector);
  return `(() => {
    const dragging = document.querySelector("[data-layout-dragging]");
    const siblingSelector = ${sibling};
    const sibling =
      siblingSelector === null ? null : document.querySelector(siblingSelector);
    const rect = sibling === null ? null : sibling.getBoundingClientRect();
    return {
      dragging:
        dragging === null
          ? null
          : (dragging.getAttribute("data-layout-member") ??
             dragging.getAttribute("data-layout-region")),
      transform: dragging === null ? null : dragging.style.transform,
      draggingCenter: (() => {
        if (dragging === null) return null;
        const r = dragging.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })(),
      siblingRect: rect === null ? null : { x: rect.x, y: rect.y },
    };
  })()`;
}

// --- phase 2: drags ---------------------------------------------------------

/**
 * The seven drags, with the two toolbar ones built from the arrangement the
 * app actually holds.
 *
 * The toolbar's membership is not a constant this driver may restate: the
 * cluster had three members while this was being written and has two now, and
 * a hardcoded pair would read as "the drag is broken" the moment one of them
 * is retired.
 *
 * BOTH directions, because both are now performable (L-143). The leftward one
 * is the case this driver once had to reverse: a member claimed a slot only
 * when its CENTRE passed the neighbour's, and the clamp keeps it inside its
 * cluster, so a WIDE member pulled in front of a narrower one at the cluster's
 * leading edge could never get its centre far enough left. Measured on this
 * composer: `access` is 120px wide at x 274.5, `attachImage` is at x 242.5,
 * and the cluster ends at 394.5 - so the furthest left `access` could be
 * dropped put its centre at 302.5 while `attachImage`'s is 256.5, and the drop
 * was refused however hard the pointer pulled. The slot is claimed by the
 * LEADING EDGE now, which `access` gets past 256.5 at an offset of -18, well
 * inside the clamp's 32px of travel - so this is the gesture that has to stay
 * possible, and it is asserted rather than described.
 */
function buildDragPlans(toolbarLeft, dock) {
  const first = toolbarLeft.at(0);
  const last = toolbarLeft.at(-1);
  const dockLast = dock.at(-1);
  const dockBefore = dock.at(-2);
  const toolbarPlan =
    first === undefined || last === undefined || first === last
      ? []
      : [
          {
            id: "toolbar member within its cluster",
            setup: ["window.__layoutCanvasProbe.reset()"],
            memberId: first,
            memberSelector: regionSelector(first),
            siblingSelector: regionSelector(last),
            target: {
              kind: "member",
              selector: regionSelector(last),
              dx: DROP_OVERSHOOT,
              dy: 0,
            },
            expect: {
              kind: "order",
              group: "toolbarLeft",
              ids: placedBeside(toolbarLeft, first, last, true),
            },
          },
          {
            id: "toolbar member leftwards past the cluster's leading member",
            setup: ["window.__layoutCanvasProbe.reset()"],
            memberId: last,
            memberSelector: regionSelector(last),
            siblingSelector: regionSelector(first),
            target: {
              kind: "member",
              selector: regionSelector(first),
              dx: -DROP_OVERSHOOT,
              dy: 0,
            },
            expect: {
              kind: "order",
              group: "toolbarLeft",
              ids: placedBeside(toolbarLeft, last, first, false),
            },
          },
        ];
  return [
    {
      id: "compact pill past a sibling pill",
      setup: [
        "window.__layoutCanvasProbe.reset()",
        "window.__layoutCanvasProbe.foldDockPills()",
      ],
      memberId: "changedFiles",
      memberSelector: regionSelector("changedFiles"),
      siblingSelector: regionSelector("runningAgents"),
      target: {
        kind: "member",
        selector: regionSelector("runningAgents"),
        dx: DROP_OVERSHOOT,
        dy: 0,
      },
      expect: {
        kind: "order",
        group: "dock",
        ids: placedBeside(dock, "changedFiles", "runningAgents", true),
      },
    },
    {
      id: "full dock row past a sibling row",
      setup: [
        "window.__layoutCanvasProbe.reset()",
        "window.__layoutCanvasProbe.unfoldDockPills()",
      ],
      memberId: dockLast,
      memberSelector: regionSelector(dockLast),
      siblingSelector: regionSelector(dockBefore),
      target: {
        kind: "member",
        selector: regionSelector(dockBefore),
        dx: 0,
        dy: -DROP_OVERSHOOT,
      },
      expect: {
        kind: "order",
        group: "dock",
        ids: placedBeside(dock, dockLast, dockBefore, false),
      },
    },
    ...toolbarPlan,
    {
      id: "rail icon across a divider",
      setup: [
        "window.__layoutCanvasProbe.reset()",
        "window.__layoutCanvasProbe.addRailDivider()",
      ],
      memberId: "railTerminals",
      memberSelector: regionSelector("railTerminals"),
      siblingSelector: '[data-layout-member="divider:1"]',
      target: {
        kind: "member",
        selector: '[data-layout-member="divider:1"]',
        // The sample sidebar is expanded, so its rail runs horizontally (F3).
        dx: -DROP_OVERSHOOT,
        dy: 0,
        // A 36px icon against an 8px divider: the overshoot has to be
        // measured on the edge that claims the slot, or the icon passes the
        // PANEL before the divider too (L-143).
        leadingEdge: true,
      },
      expect: { kind: "rail", ids: TERMINALS_ABOVE_THE_DIVIDER },
    },
    {
      id: "rail divider itself",
      setup: [
        "window.__layoutCanvasProbe.reset()",
        "window.__layoutCanvasProbe.addRailDivider()",
      ],
      memberId: "divider:1",
      memberSelector: '[data-layout-member="divider:1"]',
      siblingSelector: regionSelector("railTerminals"),
      target: {
        kind: "member",
        selector: regionSelector("railTerminals"),
        dx: DROP_OVERSHOOT,
        dy: 0,
      },
      expect: { kind: "rail", ids: TERMINALS_ABOVE_THE_DIVIDER },
    },
    {
      id: "the clamp: a rail icon pulled far outside the column",
      setup: ["window.__layoutCanvasProbe.reset()"],
      memberId: "railComments",
      memberSelector: regionSelector("railComments"),
      siblingSelector: null,
      // The expanded sample sidebar's rail runs horizontally (F3).
      target: { kind: "viewport", dx: -60, dy: 300, axis: "x" },
      expect: { kind: "none" },
    },
  ];
}

async function runDrag(client, plan) {
  const violations = [];
  const notes = [];
  const depthAtSetup = await evaluate(
    client,
    "window.__layoutCanvasProbe.historyDepth()",
  );
  for (const expression of plan.setup) await evaluate(client, expression);
  await flush(client);
  await delay(250);
  await flush(client);

  const member = await rectOf(client, plan.memberSelector);
  if (member === null) {
    violations.push(`A5 ${plan.id}: nothing matches ${plan.memberSelector}`);
    return { violations, notes };
  }
  let to;
  if (plan.target.kind === "member") {
    const anchor = await rectOf(client, plan.target.selector);
    if (anchor === null) {
      violations.push(`A5 ${plan.id}: no drop anchor ${plan.target.selector}`);
      return { violations, notes };
    }
    to = { x: anchor.cx + plan.target.dx, y: anchor.cy + plan.target.dy };
    if (plan.target.leadingEdge === true) {
      // `to` named where the member's LEADING EDGE should land (L-143); the
      // pointer is half a member behind it, on the axis the drag travels.
      to = {
        x:
          plan.target.dx === 0
            ? to.x
            : to.x - Math.sign(plan.target.dx) * (member.width / 2),
        y:
          plan.target.dy === 0
            ? to.y
            : to.y - Math.sign(plan.target.dy) * (member.height / 2),
      };
    }
  } else {
    const view = await evaluate(
      client,
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    to = { x: view.width + plan.target.dx, y: view.height + plan.target.dy };
  }

  const siblingBefore =
    plan.siblingSelector === null
      ? null
      : await rectOf(client, plan.siblingSelector);
  const before = await evaluate(
    client,
    "window.__layoutCanvasProbe.snapshot()",
  );
  const depthBefore = await evaluate(
    client,
    "window.__layoutCanvasProbe.historyDepth()",
  );

  const mid = await dragPointer(client, member, to, plan.siblingSelector);

  const after = await evaluate(client, "window.__layoutCanvasProbe.snapshot()");
  const depthAfter = await evaluate(
    client,
    "window.__layoutCanvasProbe.historyDepth()",
  );

  if (mid === null || mid.dragging === null) {
    violations.push(
      `A5 ${plan.id}: nothing carried [data-layout-dragging] mid-gesture, so the press never became a drag (from ${boxText(member)} to ${JSON.stringify(to)})`,
    );
  } else if (mid.dragging !== plan.memberId) {
    violations.push(
      `A5 ${plan.id}: the element in hand was ${String(mid.dragging)}, expected ${plan.memberId}`,
    );
  }

  if (plan.expect.kind === "none") {
    // The clamp: the member may travel, but not as far as the pointer did, and
    // it may not be dropped anywhere (L-29).
    // Where the member is PAINTED, against the pointer, on the rail's axis:
    // the pull across it is the clamp's too, but not what it moves along.
    const axis = plan.target.axis;
    const raw =
      axis === "y" ? Math.abs(to.y - member.cy) : Math.abs(to.x - member.cx);
    const travelled =
      mid === null || mid.draggingCenter === null
        ? null
        : axis === "y"
          ? Math.abs(mid.draggingCenter.y - member.cy)
          : Math.abs(mid.draggingCenter.x - member.cx);
    notes.push(
      `clamp: pointer pulled ${raw.toFixed(0)}px to ${JSON.stringify(to)}, member travelled ${travelled === null ? "n/a" : travelled.toFixed(0)}px`,
    );
    if (travelled === null) {
      violations.push(`A5 ${plan.id}: no member in hand to measure`);
    } else if (travelled > raw / 2) {
      // Unclamped, the member trails the pointer by the 6px activation
      // distance alone (`drag-engine.ts`), so it would cover nearly all of the
      // pull; clamped, it stops at its cluster's edge plus the rubber band.
      violations.push(
        `A5 ${plan.id}: the member followed the pointer ${travelled.toFixed(0)}px of ${raw.toFixed(0)}px, so nothing clamped it to its cluster`,
      );
    }
    if (
      JSON.stringify(after.arrangement) !== JSON.stringify(before.arrangement)
    ) {
      violations.push(
        `A5 ${plan.id}: the arrangement was written although the member was pulled out of its cluster`,
      );
    }
    if (depthAfter !== depthBefore) {
      violations.push(
        `A5 ${plan.id}: history went ${String(depthBefore)} -> ${String(depthAfter)}; a clamped drag writes nothing`,
      );
    }
    return { violations, notes };
  }

  if (siblingBefore !== null) {
    if (mid === null || mid.siblingRect === null) {
      violations.push(`A5 ${plan.id}: could not measure the sibling mid-drag`);
    } else if (
      Math.abs(mid.siblingRect.x - siblingBefore.x) < 1 &&
      Math.abs(mid.siblingRect.y - siblingBefore.y) < 1
    ) {
      violations.push(
        `A5 ${plan.id}: the sibling did not reflow mid-drag (still at ${mid.siblingRect.x.toFixed(1)}, ${mid.siblingRect.y.toFixed(1)})`,
      );
    }
  }

  const actual =
    plan.expect.kind === "rail"
      ? after.arrangement.rail.map((entry) => entry.id)
      : after.arrangement[plan.expect.group];
  if (JSON.stringify(actual) !== JSON.stringify(plan.expect.ids)) {
    violations.push(
      `A5 ${plan.id}: the layout store reads ${JSON.stringify(actual)}, expected ${JSON.stringify(plan.expect.ids)} (dragged from ${boxText(member)} to ${JSON.stringify(to)})`,
    );
  }
  if (depthAfter - depthBefore !== 1) {
    violations.push(
      `A5 ${plan.id}: history went ${String(depthBefore)} -> ${String(depthAfter)}; one drag is exactly one step (L-18)`,
    );
  }
  notes.push(
    `drag "${plan.id}": ${JSON.stringify(actual)}, history +${String(depthAfter - depthBefore)}`,
  );
  return { violations, notes };
}

/**
 * `layout-arrangement.ts`'s `placedBeside`, restated for the EXPECTATION.
 *
 * The expected order is computed from the order the app is actually holding
 * rather than written out, so a cluster that gains a member - the dock is
 * gained Todo - changes what the drop should produce without
 * changing this driver. The arithmetic is the product's own: take the member
 * out, put it back beside the anchor.
 */
function placedBeside(order, moved, anchor, after) {
  const rest = order.filter((id) => id !== moved);
  const at = rest.indexOf(anchor);
  if (at < 0) return order;
  const insertAt = after ? at + 1 : at;
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
}

// --- phase 2: small helpers -------------------------------------------------

async function flush(client) {
  await evaluate(
    client,
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

async function rectOf(client, selector) {
  return await evaluate(
    client,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
      };
    })()`,
  );
}

/**
 * A point that is really INSIDE the region, for the surfaces whose named
 * element is `display: contents` outside an editor session: such an element
 * generates no box, so its `getBoundingClientRect()` is `0,0,0,0` and a click
 * aimed at its centre lands in the window's top-left corner.
 */
async function pointInside(client, selector) {
  return await evaluate(
    client,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node === null) return null;
      const boxOf = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const own = boxOf(node);
      const rect =
        own ??
        [...node.querySelectorAll("*")]
          .map(boxOf)
          .find((candidate) => candidate !== null) ??
        null;
      if (rect === null) return null;
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        boxless: own === null,
      };
    })()`,
  );
}

async function resetSession(client) {
  await evaluate(client, "window.__layoutCanvasProbe.endSession()");
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await evaluate(client, "window.__layoutCanvasProbe.beginSession()");
  await flush(client);
  await delay(300);
  await flush(client);
}

async function hoverIndexRow(client, regionId) {
  // The row lives on its area's level of the two-level form, opened with no
  // row selected so the hover alone is what asks for the ghost.
  await evaluate(
    client,
    `window.__layoutCanvasProbe.openAreaOf(${JSON.stringify(regionId)})`,
  );
  await flush(client);
  const selector = `[data-layout-inspector] [data-sortable-id="${regionId}"]`;
  const found = await evaluate(
    client,
    `(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      if (row === null) return false;
      row.scrollIntoView({ block: "center" });
      return true;
    })()`,
  );
  if (!found) {
    return {
      error: `the inspector index has no row for ${regionId}`,
      ghost: null,
      rect: null,
      cluster: null,
      inCompactStrip: false,
    };
  }
  await flush(client);
  const row = await rectOf(client, selector);
  await moveTo(client, row.cx, row.cy);
  await flush(client);
  await delay(200);
  await flush(client);
  return await evaluate(
    client,
    `(() => {
      const node = document.querySelector(${JSON.stringify(regionSelector(regionId))});
      if (node === null)
        return {
          error: "the hovered index row materialised nothing on the canvas",
          ghost: null,
          rect: null,
          cluster: null,
          inCompactStrip: false,
        };
      const rect = node.getBoundingClientRect();
      const cluster = node.closest("[data-layout-cluster]");
      const testId = cluster === null ? null : cluster.getAttribute("data-testid");
      return {
        error: null,
        ghost: node.getAttribute("data-ghost"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        cluster: testId,
        inCompactStrip: testId === "chat-dock-compact-strip",
      };
    })()`,
  );
}

async function rightClickMenu(client, x, y) {
  await moveTo(client, x, y);
  await pressAndRelease(client, x, y, "right");
  await delay(300);
  await flush(client);
  return await evaluate(
    client,
    `(() => {
      const menu = document.querySelector('[role="menu"]');
      return { open: menu !== null, text: menu === null ? "" : (menu.textContent ?? "") };
    })()`,
  );
}

async function dismissLayers(client) {
  for (const type of ["keyDown", "keyUp"]) {
    await client.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await delay(200);
  await flush(client);
}

/**
 * The page-side pixel tools, installed if this document has not got them.
 *
 * Vite's dev client answers a source edit with a FULL page reload, which takes
 * everything this driver injected with it. Re-installing on demand rather than
 * once is what keeps a measurement from dying as
 * `window.__swatch is not a function` twenty assertions in; whether a reload
 * happened at all is reported separately, because a document that was rebuilt
 * mid-run is not one these numbers describe.
 */
async function ensurePixelTools(client) {
  const installed = await evaluate(
    client,
    'typeof window.__swatch === "function"',
  );
  if (!installed) await evaluate(client, INSTALL_PIXEL_TOOLS);
}

async function sampleAmber(client) {
  await ensurePixelTools(client);
  const spot = await evaluate(client, "window.__swatch(true)");
  if (spot === null) return null;
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: spot.left + 4, y: spot.top + 4, width: 4, height: 4, scale: 1 },
    captureBeyondViewport: false,
  });
  const pixel = await evaluate(
    client,
    `window.__samplePixel(${JSON.stringify(shot.data)})`,
  );
  await evaluate(client, "window.__swatch(false)");
  return pixel;
}

/**
 * One edge's STRAIGHT run, counted at the frame's own inset.
 *
 * Both ends are cut by `inset + radius`, because the frame's corners are arcs
 * and an arc leaves the straight edge before the column's corner does: counted
 * to the corner, a deliberate 12px radius reads as an unlit stretch at each
 * end of every edge. What is left is the part of the edge that is supposed to
 * be a straight dotted line, which is the thing LV2-04 was about.
 */
async function countEdge(client, column, edge, target, frame) {
  await ensurePixelTools(client);
  const horizontal = edge === "top" || edge === "bottom";
  const cut = frame.inset + frame.radius;
  const near = Math.max(0, frame.inset - FRAME_BAND_BEFORE_INSET);
  const thickness = FRAME_BAND_BEFORE_INSET + FRAME_BAND_AFTER_INSET;
  const clip = horizontal
    ? {
        x: column.x + cut,
        y:
          edge === "top"
            ? column.y + near
            : column.y + column.height - near - thickness,
        width: Math.max(1, column.width - cut * 2),
        height: thickness,
      }
    : {
        x:
          edge === "left"
            ? column.x + near
            : column.x + column.width - near - thickness,
        y: column.y + cut,
        width: thickness,
        height: Math.max(1, column.height - cut * 2),
      };
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: false,
  });
  return await evaluate(
    client,
    `window.__countShot(${JSON.stringify(shot.data)}, ${String(horizontal)}, ${JSON.stringify(target)}, 90)`,
  );
}

/**
 * A CSS length that is written in plain pixels, or `null`.
 *
 * `getPropertyValue` on a custom property returns the token as authored, so
 * `Number.parseFloat` is only meaningful once the unit has been checked: it
 * reads `0.25rem` as 0.25 and `calc(4px)` as NaN, and a caller that took
 * either would be measuring a number the stylesheet never expressed.
 */
function pxValue(token) {
  if (typeof token !== "string") return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(token.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * One arbitrary box, counted by COLUMN: how many of its `width` columns hold a
 * pixel within tolerance of the target colour.
 *
 * `countEdge` asks the same question of a band it computes from the column and
 * an edge; this one takes the box, because the frame's rectangle corner is a
 * box the caller knows and the edge geometry does not. It reads `lit === 0`
 * when the design is right, which is the direction a pixel count can be
 * trusted in: a dotted stroke's phase can hide ink, it cannot invent it.
 */
async function countBox(client, box, target) {
  await ensurePixelTools(client);
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.max(1, box.width),
      height: Math.max(1, box.height),
      scale: 1,
    },
    captureBeyondViewport: false,
  });
  return await evaluate(
    client,
    `window.__countShot(${JSON.stringify(shot.data)}, true, ${JSON.stringify(target)}, 90)`,
  );
}

function sameBoxWithin(left, right, tolerance) {
  return (
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

function boxText(box) {
  return `[${box.x.toFixed(1)}, ${box.y.toFixed(1)}, ${box.width.toFixed(1)}x${box.height.toFixed(1)}]`;
}
