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
});
