/**
 * Where the New Conversation modal's height cap and its scroll region live.
 *
 * Both halves are load-bearing and neither is visible off a phone, which is why
 * they are asserted from the source rather than left to review. The card is
 * `-translate-y-1/2` centred, so an uncapped one grew with the draft and
 * spilled off BOTH edges of the screen with nothing to scroll - on a phone the
 * lines someone had just typed simply left the box.
 *
 * The cap alone would not fix that (an overflowing child is still painted), so
 * a scroll region is the other half - and it must sit on the BODY, never on
 * `DialogContent`. That node is the portal target the workspace controls'
 * popovers mount into (`DialogOverlayBoundaryContext`) and it carries a
 * transform, making it their containing block even when they position `fixed`.
 * An overflow container there would clip them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "../new-conversation-modal.tsx"),
  "utf8",
);

/** The `className` string on the element carrying `testId`. */
function classNameOf(testId: string): string {
  const match = source.match(
    new RegExp(`className="([^"]*)"[^>]*?data-testid="${testId}"`),
  );
  expect(match, `className beside data-testid="${testId}"`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("new conversation modal scroll boundary", () => {
  it("caps the card against the same band that centres it", () => {
    // `--spacing-safe-dvh` and `top-safe-center-y` measure the same region, so
    // a cap expressed against it agrees with the centring by construction -
    // less a 1rem gutter at each end.
    expect(classNameOf("epic-sidebar-new-conversation-modal")).toContain(
      "max-h-[calc(var(--spacing-safe-dvh)-2rem)]",
    );
  });

  it("scrolls the body, not the node the workspace popovers portal into", () => {
    expect(classNameOf("epic-sidebar-new-conversation-modal-body")).toContain(
      "overflow-y-auto",
    );
    expect(classNameOf("epic-sidebar-new-conversation-modal")).not.toMatch(
      /\boverflow-/,
    );
  });
});
