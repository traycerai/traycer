import { readFileSync } from "node:fs";
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
});
