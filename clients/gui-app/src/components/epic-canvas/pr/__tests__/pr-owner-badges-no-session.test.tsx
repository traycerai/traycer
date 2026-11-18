import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PrOwnerBadges } from "@/components/epic-canvas/pr/pr-owner-label";

/**
 * Deliberately does NOT mock `@/lib/epic-selectors` - the point is the REAL
 * hooks, which throw "useOpenEpicHandle must be called inside
 * <EpicSessionProvider>" when the session handle is absent.
 *
 * That is not a hypothetical: `EpicSessionProvider` renders its children BEFORE
 * it holds a handle (desktop ownership claim, then acquire), and the PR list
 * arrives on its own host stream, which waits for no epic session - so
 * fully-populated rows paint while the context is still null. Every owner chip
 * reads the projection, so the whole subtree has to be session-gated; ungated
 * it took the route's error boundary down and the window showed "Something went
 * wrong". The sibling test file mocks the selectors away and so is blind to it.
 */
afterEach(cleanup);

const OWNERS = [
  { ownerId: "chat-1", ownerKind: "chat" as const },
  { ownerId: "chat-2", ownerKind: "chat" as const },
];

describe("PrOwnerBadges without an epic session", () => {
  it("renders nothing for a PR WITH owners instead of throwing", () => {
    expect(() =>
      render(
        <PrOwnerBadges
          owners={OWNERS}
          epicId="epic-1"
          fallbackHostId="host-1"
          className={undefined}
        />,
      ),
    ).not.toThrow();

    // Not a degraded row either - no chip can be named without the projection.
    expect(screen.queryByTestId("pr-owner-badges")).toBeNull();
    expect(screen.queryByTestId("pr-owner-badge")).toBeNull();
  });

  it("renders nothing for an ownerless PR instead of throwing", () => {
    expect(() =>
      render(
        <PrOwnerBadges
          owners={[]}
          epicId="epic-1"
          fallbackHostId="host-1"
          className={undefined}
        />,
      ),
    ).not.toThrow();

    expect(screen.queryByTestId("pr-owner-badges")).toBeNull();
  });
});
