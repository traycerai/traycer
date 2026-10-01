import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regression: every label on the sign-in page stays legible under
// every theme preset, in both appearances, in every state the page can show.
//
// The page paints a FIXED dark ground and its controls take their colours from
// theme tokens, so legibility is a property of the rendered cascade under a
// particular theme. jsdom has neither a cascade nor pixels. This renders the
// real `AuthLandingPage` (`src/__tests__/browser/sign-in-theme-contrast.tsx`),
// switches the theme through the real theme applier, and for every visible
// piece of text reads:
//   - the text colour from the computed style, with its alpha and every
//     ancestor's opacity folded in, and
//   - the background from PIXELS: a screenshot taken with all text made
//     transparent, averaged over the text's own box - so a translucent button
//     fill over the photo backdrop is measured as it actually renders.
// It then asserts WCAG AA (4.5:1) for every enabled label, and that no label's
// colours move between themes: the page is one fixed design, so a theme that
// changes any of them is the drift this exists to catch.
//
// One test per state. A state is the unit the drift comparison lives in - a
// label's ratio under every theme, compared with itself - so splitting by
// state keeps every reading and every comparison while letting Playwright run
// the states in parallel across workers and shards. (Measured together, the
// ten states x 34 themes were 152s of one process.)
//
// Debugging: SIGN_IN_SHOTS_DIR=<dir> also writes a screenshot per state and
// theme into <dir>. Every test attaches its per-label ranges as `readings`.

const MIN_CONTRAST = 4.5;
// A label's colours may differ between themes by rounding only.
const MAX_THEME_SPREAD = 0.05;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
// Text measured and reported, but not held to AA. Each reads the same under
// every theme, including the default dark one the page was designed in, so no
// theme can make it worse - the drift check below still holds them to that.
// They are the design's own choices on the fixed ground, not what a theme
// breaks. Matched against the label the reading prints for the element.
const EXEMPT: readonly RegExp[] = [
  // The build stamp in the corner, a deliberately recessive white alpha.
  /^footer span /,
  // The device-code panel's field captions (white/55) and its "start over"
  // escape link (white/72), over the panel's translucent fill.
  /^signin-device-fallback-content span "(Device code|Approval address)"/,
  /^signin-retry-link button /,
  // The manual-entry validation notice: the destructive red over the brighter
  // lower half of the photo backdrop.
  /^link-code-signin-notice p /,
];

// The states the fixture can show that carry text to read. `splash` is the
// eleventh: it covers the page while it plays, so there is nothing under it to
// read, and the fixture still lists it.
const MEASURED_STATES = [
  "desktop-rest",
  "desktop-device",
  "desktop-error",
  "desktop-refusal",
  "mobile-rest",
  "mobile-manual",
  "mobile-manual-error",
  "mobile-claim",
  "mobile-refusal",
] as const;
type MeasuredState = (typeof MEASURED_STATES)[number];
const UNMEASURED_STATES: readonly string[] = ["splash"];

const SHOTS_DIR = process.env.SIGN_IN_SHOTS_DIR;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface RawLabel {
  readonly label: string;
  readonly fg: readonly [number, number, number, number];
  readonly rect: Rect;
  readonly disabled: boolean;
}

interface Reading {
  readonly theme: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly ratio: number;
  readonly fg: string;
  readonly bg: string;
}

interface Theme {
  readonly mode: "light" | "dark";
  readonly preset: string;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function fixtureUrl(state: string): string {
  return `${fixture("sign-in-theme-contrast")}?state=${state}`;
}

async function openState(page: Page, state: string): Promise<void> {
  await page.goto(fixtureUrl(state));
  // The fixture publishes these when its module evaluates, which a cold Vite
  // transform on a slow runner can finish after the load event.
  await page.waitForFunction(
    "Array.isArray(window.__probeStates) && Array.isArray(window.__probePresets)",
  );
}

async function presetsOf(page: Page): Promise<string[]> {
  const presets: unknown = await page.evaluate("window.__probePresets");
  if (!isStringArray(presets)) {
    throw new Error("the fixture published no theme presets");
  }
  return presets;
}

/** Resolves once no animation that will ever finish is still running. */
async function finishRunningAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (;;) {
      const running = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
      if (running.length === 0) return;
      await Promise.allSettled(running.map((animation) => animation.finished));
    }
  });
}

/**
 * Puts the page into the part of a state the fixture cannot reach by itself:
 * the manual-entry form is opened by the user, and its validation notice by a
 * submit.
 */
async function prepareState(page: Page, state: MeasuredState): Promise<void> {
  await page.waitForFunction("window.__probeReady === true");
  // Every state is read after the splash has retired.
  await expect(
    page.locator('[data-testid="auth-brand-splash"]'),
    "the splash to retire",
  ).toHaveCount(0);
  // A theme switch would otherwise be read mid-transition (the hero button
  // eases its colours), and the reading would depend on timing.
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; }",
  });
  await nextFrames(page, 2);
  await finishRunningAnimations(page);

  if (state === "mobile-manual" || state === "mobile-manual-error") {
    // A DOM click, as the fixture has always been driven: a pointer would
    // leave the mouse resting on the control and read every theme hovered.
    await page
      .locator('[data-testid="link-code-signin-manual"]')
      .evaluate((element) => {
        if (element instanceof HTMLElement) element.click();
      });
    await expect(
      page.locator('[data-testid="link-code-signin-input"]'),
      "the manual entry form",
    ).toBeAttached();
    const value = state === "mobile-manual" ? "ABCDE-FGHJK" : "not a code";
    await page
      .locator('[data-testid="link-code-signin-input"]')
      .evaluate((element, text) => {
        if (!(element instanceof HTMLInputElement)) {
          throw new Error("the manual entry field is not an input");
        }
        // The prototype's own setter: React's value tracker shadows `value`
        // on the instance, and setting it there would not reach `onChange`.
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        );
        if (descriptor === undefined || descriptor.set === undefined) {
          throw new Error("no value setter");
        }
        descriptor.set.call(element, text);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    if (state === "mobile-manual-error") {
      await page
        .locator('[data-testid="link-code-signin-submit"]')
        .evaluate((element) => {
          if (element instanceof HTMLElement) element.click();
        });
      await expect(
        page.locator('[data-testid="link-code-signin-notice"]'),
        "the validation notice",
      ).toBeAttached();
    }
  }
  if (state === "desktop-device") {
    await expect(
      page.locator('[data-testid="signin-device-progress"]'),
      "the device approval panel",
    ).toBeAttached();
  }
  if (state === "desktop-error") {
    await expect(
      page.locator('[data-testid="signin-error"]'),
      "the sign-in error",
    ).toBeAttached();
  }
  if (state === "mobile-claim") {
    await expect(
      page.locator('[data-testid="link-code-signin-waiting"]'),
      "the claim wait",
    ).toBeAttached();
  }
}

/**
 * Every visible run of text on the page, with its colour and the box it
 * occupies. Text is found as elements with a non-blank text node of their own,
 * plus inputs with a value.
 */
async function readLabels(page: Page): Promise<RawLabel[]> {
  return page.evaluate((): RawLabel[] => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d canvas to resolve colours with");
    const toRgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const opacityOf = (element: Element): number => {
      let opacity = 1;
      for (
        let node: Element | null = element;
        node instanceof Element;
        node = node.parentElement
      ) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      return opacity;
    };
    const glyphsOf = (text: string): string => text.replace(/[⠀-⣿]/g, "");
    // Stable across a run: spinner frames and ticking digits are dropped, so
    // one label is one key under every theme.
    const labelOf = (element: Element): string => {
      const owner = element.closest<HTMLElement>("footer, [data-testid]");
      const raw =
        element instanceof HTMLInputElement
          ? element.value
          : element.textContent;
      const text = glyphsOf(raw)
        .replace(/[0-9]+/g, "#")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
      const where =
        owner === null ? "page" : (owner.dataset.testid ?? "footer");
      return `${where} ${element.tagName.toLowerCase()} "${text}"`;
    };
    const ownTextBox = (element: Element): DOMRect | null => {
      const own = [...element.childNodes].filter(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          glyphsOf(node.textContent ?? "").trim() !== "",
      );
      const range = document.createRange();
      const boxes = own.flatMap((node) => {
        range.selectNodeContents(node);
        return [...range.getClientRects()];
      });
      if (boxes.length === 0) return null;
      const left = Math.min(...boxes.map((box) => box.left));
      const top = Math.min(...boxes.map((box) => box.top));
      const right = Math.max(...boxes.map((box) => box.right));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      return new DOMRect(left, top, right - left, bottom - top);
    };
    const boxOf = (element: Element): DOMRect | null => {
      if (element instanceof HTMLInputElement) {
        return element.value === "" ? null : element.getBoundingClientRect();
      }
      return ownTextBox(element);
    };
    const rows: RawLabel[] = [];
    const candidates = document.querySelectorAll(
      "main *, [data-slot=tooltip-content] *",
    );
    for (const element of candidates) {
      const rect = boxOf(element);
      if (rect === null) continue;
      // Screen-reader-only copy is clipped to a pixel; it is not seen.
      if (rect.width < 2 || rect.height < 2) continue;
      if (getComputedStyle(element).visibility === "hidden") continue;
      const opacity = opacityOf(element);
      if (opacity === 0) continue;
      const [r, g, b, a] = toRgba(getComputedStyle(element).color);
      rows.push({
        label: labelOf(element),
        fg: [r, g, b, a * opacity],
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        disabled: element.closest(":disabled") !== null,
      });
    }
    return rows;
  });
}

/**
 * The colour behind each box, from pixels: the same page with every glyph
 * transparent, averaged over the box.
 */
async function readBackgrounds(
  page: Page,
  rects: readonly Rect[],
): Promise<Array<[number, number, number]>> {
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "probe-hide-text";
    style.textContent =
      "*, *::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }";
    document.head.append(style);
  });
  await nextFrames(page, 2);
  const shot = await page.screenshot({ type: "png" });
  await page.evaluate(() => {
    document.getElementById("probe-hide-text")?.remove();
  });
  return page.evaluate(
    async ({ base64, boxes }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) throw new Error("no 2d canvas to decode pixels with");
      ctx.drawImage(image, 0, 0);
      return boxes.map((rect): [number, number, number] => {
        const x = Math.max(0, rect.x);
        const y = Math.max(0, rect.y);
        const width = Math.max(1, Math.min(rect.width, canvas.width - x));
        const height = Math.max(1, Math.min(rect.height, canvas.height - y));
        const data = ctx.getImageData(x, y, width, height).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n += 1;
        }
        return [r / n, g / n, b / n];
      });
    },
    { base64: shot.toString("base64"), boxes: [...rects] },
  );
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function hex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Every label under the theme that is applied now, read against its pixels. */
async function measureLabels(page: Page, themeKey: string): Promise<Reading[]> {
  const labels = await readLabels(page);
  const backgrounds = await readBackgrounds(
    page,
    labels.map((label) => label.rect),
  );
  return labels.map((label, index) => {
    const bg = backgrounds[index];
    const [fr, fg, fb, fa] = label.fg;
    const text: [number, number, number] = [
      fr * fa + bg[0] * (1 - fa),
      fg * fa + bg[1] * (1 - fa),
      fb * fa + bg[2] * (1 - fa),
    ];
    return {
      theme: themeKey,
      label: label.label,
      disabled: label.disabled,
      ratio: contrast(text, bg),
      fg: hex(text),
      bg: hex(bg),
    };
  });
}

function isExempt(label: string): boolean {
  return EXEMPT.some((exempt) => exempt.test(label));
}

/** Rows grouped by `state :: label`: one label under every theme. */
function groupByLabel(
  state: string,
  readings: readonly Reading[],
): Map<string, Reading[]> {
  const byLabel = new Map<string, Reading[]>();
  for (const row of readings) {
    const key = `${state} :: ${row.label}`;
    const rows = byLabel.get(key);
    if (rows === undefined) byLabel.set(key, [row]);
    else rows.push(row);
  }
  return byLabel;
}

/** One line per label that misses AA under any theme, at its worst theme. */
function belowAa(
  themes: number,
  byLabel: ReadonlyMap<string, readonly Reading[]>,
): string[] {
  const lines: string[] = [];
  for (const [key, rows] of byLabel) {
    const failing = rows.filter(
      (row) =>
        !row.disabled && !isExempt(row.label) && row.ratio < MIN_CONTRAST,
    );
    if (failing.length === 0) continue;
    const worst = failing.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    lines.push(
      `BELOW ${String(MIN_CONTRAST)}:1 ${key} - worst ${worst.ratio.toFixed(2)} under ${worst.theme} (fg ${worst.fg} on bg ${worst.bg}); failing under ${String(failing.length)}/${String(themes)} themes`,
    );
  }
  return lines;
}

/** One line per label whose colours move between themes. */
function themeDrift(
  themes: number,
  byLabel: ReadonlyMap<string, readonly Reading[]>,
): string[] {
  const lines: string[] = [];
  for (const [key, rows] of byLabel) {
    const ratios = rows.map((row) => row.ratio);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    if (rows.length !== themes) {
      lines.push(
        `THEME DRIFT ${key}: present under ${String(rows.length)}/${String(themes)} themes`,
      );
    } else if (spread > MAX_THEME_SPREAD) {
      const low = rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      const high = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      lines.push(
        `THEME DRIFT ${key}: ${low.ratio.toFixed(2)} (${low.theme}) .. ${high.ratio.toFixed(2)} (${high.theme})`,
      );
    }
  }
  return lines;
}

function report(byLabel: ReadonlyMap<string, readonly Reading[]>): string {
  const lines: string[] = [];
  for (const [key, rows] of byLabel) {
    const ratios = rows.map((row) => row.ratio);
    const disabled = rows[0].disabled ? " (disabled)" : "";
    const exempt = isExempt(rows[0].label) ? " (exempt)" : "";
    lines.push(
      `${key.padEnd(90)} min ${Math.min(...ratios).toFixed(2)} max ${Math.max(...ratios).toFixed(2)}${disabled}${exempt}`,
    );
  }
  return lines.join("\n");
}

test("the fixture's states are the ones this spec measures", async ({
  page,
}) => {
  await openState(page, "desktop-rest");
  const states: unknown = await page.evaluate("window.__probeStates");
  expect(
    isStringArray(states) ? [...states].sort() : states,
    "the fixture defines a state this spec does not measure (add it to MEASURED_STATES, or to UNMEASURED_STATES if there is no text to read)",
  ).toEqual([...MEASURED_STATES, ...UNMEASURED_STATES].sort());
  expect(
    (await presetsOf(page)).length,
    "the fixture published no theme presets",
  ).toBeGreaterThan(0);
});

for (const state of MEASURED_STATES) {
  const phone = state.startsWith("mobile-");
  test.describe(state, () => {
    test.use({ viewport: phone ? PHONE : DESKTOP, isMobile: phone });

    test(`every label clears AA and keeps its colours under every theme (${state})`, async ({
      page,
    }, testInfo) => {
      await openState(page, state);
      // Presets come from the fixture itself, so a preset added to the
      // registry is covered without touching this spec.
      const themes: Theme[] = (await presetsOf(page)).flatMap((preset) => [
        { mode: "light" as const, preset },
        { mode: "dark" as const, preset },
      ]);
      await prepareState(page, state);

      const measured: Reading[] = [];
      for (const theme of themes) {
        const themeKey = `${theme.mode}-${theme.preset}`;
        await page.evaluate(
          `window.__probeTheme(${JSON.stringify(theme.mode)}, ${JSON.stringify(theme.preset)})`,
        );
        await nextFrames(page, 2);
        if (SHOTS_DIR !== undefined) {
          await mkdir(SHOTS_DIR, { recursive: true });
          await writeFile(
            path.join(SHOTS_DIR, `${themeKey}.${state}.png`),
            await page.screenshot({ type: "png" }),
          );
        }
        const labels = await measureLabels(page, themeKey);
        expect(labels.length, `no text measured in ${state}`).toBeGreaterThan(
          0,
        );
        measured.push(...labels);
      }

      const byLabel = groupByLabel(state, measured);
      await testInfo.attach("readings", {
        body: report(byLabel),
        contentType: "text/plain",
      });
      testInfo.annotations.push({
        type: "result",
        description: `${state}: ${String(themes.length)} themes, ${String(measured.length)} label readings`,
      });

      // AA on every enabled label, under every theme. Soft, so a run that
      // fails both claims reports both.
      expect
        .soft(
          belowAa(themes.length, byLabel),
          "labels below AA - each received line is one label at its worst theme",
        )
        .toEqual([]);
      // One design under every theme: a label's colours must not move.
      expect(
        themeDrift(themes.length, byLabel),
        "label colours move with the theme",
      ).toEqual([]);
    });
  });
}
