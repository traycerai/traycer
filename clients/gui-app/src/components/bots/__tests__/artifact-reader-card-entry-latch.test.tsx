/**
 * A true miss of the entry object persists while the card's logical post stays
 * mounted and nothing it was admitted on changed, however many times the card
 * scrolls out of view and back. Explicit Retry, or a change to the entry's own
 * record, ends it.
 */
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null,
}));
vi.mock("@/components/sandbox/sandbox-frame", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/sandbox/sandbox-frame")
  >()),
  SandboxFrame: (
    await import("@/components/sandbox/__tests__/artifact-frame-browser-driver")
  ).ArtifactFrameBrowserDriver,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);

import {
  admittedHandle,
  deliverSnapshot,
  installReaderCardHarness,
  intersectIn,
  localHeadEdit,
  seen,
  showCardAlone,
  SURFACE,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";

installReaderCardHarness();

/** A card whose entry object the host does not have, over a loaded task. */
async function showCardWithMissingEntry() {
  seen.objectReadsToFail = 1;
  const view = await showCardAlone(SURFACE, "row-1");
  deliverSnapshot();
  await screen.findByRole("button", { name: "Retry" });
  return view;
}

describe("a missed entry object", () => {
  it("stays missed when the card scrolls out and back with nothing changed", async () => {
    const view = await showCardWithMissingEntry();
    const readsAfterMiss = seen.objectReads;

    intersectIn(view.container, false);
    intersectIn(view.container, true);

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByTestId("artifact-frame-driver")).toBeNull();
    expect(seen.objectReads).toBe(readsAfterMiss);
  });

  it("is read again by an explicit Retry", async () => {
    await showCardWithMissingEntry();
    const readsAfterMiss = seen.objectReads;

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(seen.objectReads).toBeGreaterThan(readsAfterMiss),
    );
    await screen.findByTestId("artifact-frame-driver");
  });

  it("is read again when the entry's own record changes", async () => {
    await showCardWithMissingEntry();
    const readsAfterMiss = seen.objectReads;

    await admittedHandle().applyRootUpdate(localHeadEdit("b".repeat(64)), true);

    await waitFor(() =>
      expect(seen.objectReads).toBeGreaterThan(readsAfterMiss),
    );
    await screen.findByTestId("artifact-frame-driver");
  });
});
