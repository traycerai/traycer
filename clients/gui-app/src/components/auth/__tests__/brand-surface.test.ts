import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRAND_DARK_GROUND_CLASS,
  BRAND_DARK_GROUND_HEX,
} from "@/components/auth/brand-surface";

/**
 * The launch ground crosses a package boundary: two of the three surfaces that
 * paint it are Tailwind classes in this package, and the third is an sRGB
 * triple inside the iOS project. Nothing in either build checks them against
 * each other, so a palette change here would show up as a flash on device and
 * nowhere else.
 *
 * This reads the storyboard and holds it to the exported hex.
 */
const SPLASH_CSS = join(
  import.meta.dirname,
  "../../../styles/auth-arrival.css",
);

const ANDROID_SPLASH = join(
  import.meta.dirname,
  "../../../../../mobile/android/app/src/main/res/drawable/splash.png",
);

const STORYBOARD = join(
  import.meta.dirname,
  "../../../../../mobile/ios/App/App/Base.lproj/LaunchScreen.storyboard",
);

function channelToByte(value: string): number {
  return Math.round(Number.parseFloat(value) * 255);
}

describe("brand dark ground", () => {
  it("is the class the sign-in surfaces use", () => {
    expect(BRAND_DARK_GROUND_CLASS).toBe("bg-zinc-950");
  });

  it("matches the iOS launch storyboard's background colour", () => {
    const xml = readFileSync(STORYBOARD, "utf8");
    const background = /<color key="backgroundColor"([^/]*)\/>/.exec(xml);
    expect(background).not.toBeNull();

    const attributes = background?.[1] ?? "";
    const red = /red="([0-9.]+)"/.exec(attributes)?.[1];
    const green = /green="([0-9.]+)"/.exec(attributes)?.[1];
    const blue = /blue="([0-9.]+)"/.exec(attributes)?.[1];
    expect([red, green, blue].every((channel) => channel !== undefined)).toBe(
      true,
    );

    const hex = `#${[red, green, blue]
      .map((channel) =>
        channelToByte(channel ?? "0")
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;

    // The storyboard is dark in BOTH appearances only because it carries an
    // explicit colour; a `systemBackgroundColor` here renders white in light
    // mode, which is the flash this pins down.
    expect(hex).toBe(BRAND_DARK_GROUND_HEX);
    expect(xml).not.toContain("systemBackgroundColor");
  });

  it("keeps the splash blocking input until the fade's first frame", () => {
    const css = readFileSync(SPLASH_CSS, "utf8");
    const play = /@keyframes auth-splash-play \{([\s\S]*?)\n\}/.exec(css)?.[1];
    if (play === undefined)
      throw new Error("auth-splash-play keyframes missing");

    // `pointer-events` is discrete, and a discrete property flips at the
    // MIDPOINT of the interval between the keyframes that declare it - not at
    // the later keyframe. Declared only at 0% and at the fade, the flip lands
    // near the middle of the splash, so the layer would stop swallowing taps
    // while still fully opaque and a tap would fire an invisible control.
    //
    // The guard is a second `auto` immediately before the fade, which shrinks
    // that interval to ~0.01% of the span. This asserts the pair exists and is
    // adjacent, because a lone `auto` at 0% is exactly the defect.
    const stops = [
      ...play.matchAll(/([\d.]+)% \{[^}]*?pointer-events: (auto|none);/g),
    ].map(([, at, value]) => ({ at: Number.parseFloat(at), value }));

    const lastAuto = stops.filter((stop) => stop.value === "auto").at(-1);
    const firstNone = stops.find((stop) => stop.value === "none");
    if (lastAuto === undefined || firstNone === undefined) {
      throw new Error("pointer-events stops missing");
    }
    const gap = firstNone.at - lastAuto.at;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(0.05);
  });

  it("gives Android the same launch ground as iOS", () => {
    // Android's launch surface is `@drawable/splash` via
    // `AppTheme.NoActionBarLaunch` in `values/styles.xml`, a different
    // mechanism from the iOS storyboard and therefore a separate way for the
    // two platforms to disagree about the same colour.
    const png = readFileSync(ANDROID_SPLASH);
    // IHDR is fixed-length and first, so the first IDAT-independent pixel read
    // is simpler than decoding: assert it is a 24-bit truecolour PNG and that
    // its only colour is the ground.
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png[25]).toBe(2);

    const hex = BRAND_DARK_GROUND_HEX.replace("#", "");
    const rgb = Buffer.from(hex, "hex");
    const start = png.indexOf(Buffer.from("IDAT", "ascii")) + 4;
    const length = png.readUInt32BE(start - 8);
    const raw = inflateSync(png.subarray(start, start + length));
    // Row layout is a filter byte then RGB triples; filter 0 means the bytes
    // are the pixels themselves.
    expect(raw[0]).toBe(0);
    expect(raw.subarray(1, 4)).toEqual(rgb);
  });
});
