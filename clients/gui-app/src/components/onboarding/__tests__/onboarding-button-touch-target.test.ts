/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `.onboarding-button` is every control the tour's footer and the first-task
 * coachmark wear, on desktop and in the installed mobile app alike. The
 * acts used to size them in TSX (`actionHeightClass(mobileApp)` -> `h-11`),
 * and the rewrite that moved them into this stylesheet dropped the 44px touch
 * target with it.
 *
 * jsdom loads no stylesheet - a computed style comes back empty - so the rule
 * is read from the source file, the same way `first-task-coachmark.test.tsx`
 * pins the guide's layers.
 */
const css = readFileSync(
  join(process.cwd(), "src/components/onboarding/onboarding.css"),
  "utf8",
);

describe(".onboarding-button", () => {
  it("is 40px tall under a precise pointer", () => {
    const start = css.indexOf(".onboarding-button {");
    expect(start).toBeGreaterThan(-1);
    expect(css.slice(start, css.indexOf("}", start))).toContain(
      "min-height: 2.5rem;",
    );
  });

  it("clears the 44px touch target under a coarse one", () => {
    expect(css).toMatch(
      /@media \(pointer: coarse\) \{\s*\.onboarding-button \{\s*min-height: 2\.75rem;/,
    );
  });

  /**
   * And again at phone WIDTH, which is the rule that cannot fail. The review
   * measured 40px on an iPhone, so `(pointer: coarse)` did not resolve there
   * the way it does in a desktop browser - and a touch target is not a thing to
   * leave resting on a query whose answer we cannot see from here.
   */
  it("clears it again from the phone breakpoint, independently of the pointer", () => {
    const start = css.indexOf("@media (max-width: 767px) {");
    expect(start).toBeGreaterThan(-1);
    const phoneBlock = css.slice(start);
    expect(phoneBlock).toMatch(
      /\.onboarding-button \{\s*min-height: 2\.75rem;/,
    );
    // The footer's primary is 48px, and full width inside the act's gutters.
    expect(phoneBlock).toMatch(
      /\.onboarding-button--block \{\s*width: 100%;\s*min-height: 3rem;/,
    );
    // The header's glyph-only Back is square rather than a 44px-tall sliver.
    expect(phoneBlock).toMatch(
      /\.onboarding-button--icon \{\s*min-width: 2\.75rem;/,
    );
  });
});
